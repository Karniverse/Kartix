use std::process::{Command, Stdio};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use tauri::{AppHandle, Emitter, Manager};
use std::sync::{Arc, Mutex};
use std::thread;

struct JobState(Mutex<Option<u32>>);

#[derive(Serialize, Deserialize, Debug)]
pub struct MediaInfo {
    pub file_path: String,
    pub format: serde_json::Value,
    pub streams: serde_json::Value,
    pub chapters: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug)]
pub struct AudioTrackConfig {
    pub input_index: usize,
    pub title: String,
    pub action: String, // "copy", "upmix_dpl2", "discrete_51", "convert"
    pub codec: String,  // "aac", "ac3", "eac3"
    pub bitrate: String, // e.g. "320k", "auto"
    pub sample_rate: String, // e.g. "48000", "auto"
    pub normalize: bool,
    pub gain: f32,
    pub drc: f32,
}

#[derive(Deserialize, Debug)]
pub struct SubtitleTrackConfig {
    pub input_index: usize,
    pub title: String,
    pub action: String, // "copy", "burn", "none"
    pub language: String,
    pub is_default: bool,
    pub is_forced: bool,
}

#[derive(Deserialize, Debug)]
pub struct ChapterConfig {
    pub start_time: f64,
    pub end_time: f64,
    pub title: String,
}

#[derive(Deserialize, Debug)]
pub struct JobRequest {
    pub input_path: String,
    pub output_path: String,
    pub video_codec: String, // e.g., "libx264", "hevc_nvenc"
    pub crf: u8,
    pub video_bitrate: String, // e.g., "5000k"
    pub video_resolution: String,
    pub custom_width: String,
    pub custom_height: String,
    pub maintain_aspect_ratio: bool,
    pub video_fps: String,
    pub custom_fps: String,
    pub fps_mode: String,
    pub pixel_format: String,
    pub deinterlace: String,
    pub denoise: String,
    pub sharpen: String,
    pub audio_tracks: Vec<AudioTrackConfig>,
    pub subtitle_tracks: Vec<SubtitleTrackConfig>,
    pub keep_chapters: bool,
    pub custom_chapters: Vec<ChapterConfig>,
    pub cover_art_tracks: Vec<usize>,
    pub trim_start: String,
    pub trim_end: String,
}

#[tauri::command]
async fn analyze_file(file_path: String) -> Result<MediaInfo, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            "-show_chapters",
            &file_path,
        ])
        .output()
        .map_err(|e| format!("Failed to execute ffprobe: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe error: {}", err));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let format = json.get("format").cloned().unwrap_or(serde_json::json!({}));
    let streams = json.get("streams").cloned().unwrap_or(serde_json::json!([]));
    let chapters = json.get("chapters").cloned();

    Ok(MediaInfo {
        file_path,
        format,
        streams,
        chapters,
    })
}

fn parse_time(time_str: &str) -> Result<f64, ()> {
    let parts: Vec<&str> = time_str.trim().split(':').collect();
    match parts.len() {
        3 => {
            let h: f64 = parts[0].trim().parse().unwrap_or(0.0);
            let m: f64 = parts[1].trim().parse().unwrap_or(0.0);
            let s: f64 = parts[2].trim().parse().unwrap_or(0.0);
            Ok(h * 3600.0 + m * 60.0 + s)
        },
        2 => {
            let m: f64 = parts[0].trim().parse().unwrap_or(0.0);
            let s: f64 = parts[1].trim().parse().unwrap_or(0.0);
            Ok(m * 60.0 + s)
        },
        1 => {
            if let Ok(s) = parts[0].trim().parse::<f64>() {
                Ok(s)
            } else {
                Err(())
            }
        },
        _ => Err(())
    }
}

#[tauri::command]
fn start_job(app: AppHandle, request: JobRequest) -> Result<(), String> {
    thread::spawn(move || {
        let mut args = vec![
            "-y".to_string(), // overwrite output
        ];

        let mut trim_duration_sec = 0.0;
        let mut trim_start_sec = 0.0;
        let mut is_trimming = false;

        // Trimming inputs
        if !request.trim_start.is_empty() {
            if let Ok(ts) = parse_time(&request.trim_start) {
                if ts > 0.0 {
                    trim_start_sec = ts;
                    is_trimming = true;
                    args.push("-ss".to_string());
                    args.push(request.trim_start.clone());
                    args.push("-copyts".to_string());
                }
            }
        }
        
        if is_trimming && !request.trim_end.is_empty() {
            if let Ok(te) = parse_time(&request.trim_end) {
                if te > trim_start_sec {
                    trim_duration_sec = te - trim_start_sec;
                }
            }
        }

        // Add main input file (Input 0)
        args.push("-i".to_string());
        args.push(request.input_path.clone());

        // Add secondary input file specifically for subtitles to prevent filter graph deadlock (Input 1)
        if is_trimming {
            args.push("-ss".to_string());
            args.push(request.trim_start.clone());
            args.push("-copyts".to_string());
        }
        args.push("-i".to_string());
        args.push(request.input_path.clone());

        let mut has_meta_file = false;
        if !request.custom_chapters.is_empty() {
            let meta_path = format!("{}.metadata.txt", request.output_path);
            let mut meta_content = String::from(";FFMETADATA1\n");
            for chap in &request.custom_chapters {
                let mut start = chap.start_time - trim_start_sec;
                let mut end = chap.end_time - trim_start_sec;
                
                if end <= 0.0 { continue; }
                if start < 0.0 { start = 0.0; }
                
                // If the chapter starts after the trimmed video ends, skip it
                if trim_duration_sec > 0.0 && start >= trim_duration_sec { continue; }
                
                // If the chapter ends after the trimmed video ends, clamp the end time
                if trim_duration_sec > 0.0 && end > trim_duration_sec { end = trim_duration_sec; }

                meta_content.push_str("[CHAPTER]\n");
                meta_content.push_str("TIMEBASE=1/1000\n");
                meta_content.push_str(&format!("START={}\n", (start * 1000.0) as i64));
                meta_content.push_str(&format!("END={}\n", (end * 1000.0) as i64));
                meta_content.push_str(&format!("title={}\n", chap.title));
            }
            if std::fs::write(&meta_path, meta_content).is_ok() {
                // Metadata file (Input 2)
                args.push("-i".to_string());
                args.push(meta_path);
                has_meta_file = true;
            }
        }

        // Output flags to drop pre-roll and reset PTS
        if is_trimming {
            args.push("-ss".to_string());
            args.push(request.trim_start.clone());
            if trim_duration_sec > 0.0 {
                args.push("-t".to_string());
                args.push(trim_duration_sec.to_string());
            }
            args.push("-output_ts_offset".to_string());
            args.push(format!("-{}", trim_start_sec));
        }

        // Map video (from Input 0)
        args.push("-map".to_string());
        args.push("0:v:0".to_string());
        args.push("-c:v:0".to_string());
        args.push(request.video_codec.clone());

        // Chapters
        if !request.keep_chapters && request.custom_chapters.is_empty() {
            args.push("-map_chapters".to_string());
            args.push("-1".to_string());
        } else if has_meta_file {
            args.push("-map_metadata".to_string());
            // Map metadata from Input 2
            args.push("2".to_string());
        }

        if request.video_codec != "copy" {
            // Pixel format
            if request.pixel_format != "auto" {
                args.push("-pix_fmt".to_string());
                args.push(request.pixel_format.clone());
            }

            // Framerate
            let target_fps = if request.video_fps == "Custom" && !request.custom_fps.is_empty() {
                request.custom_fps.clone()
            } else if request.video_fps != "Original" {
                request.video_fps.clone()
            } else {
                "".to_string()
            };
            
            let mut vfilters = Vec::new();

            // 1. Deinterlace (Must happen before scaling to preserve fields)
            match request.deinterlace.as_str() {
                "bwdif" => vfilters.push("bwdif=mode=0".to_string()),
                "bwdif_bob" => vfilters.push("bwdif=mode=1".to_string()),
                "yadif" => vfilters.push("yadif".to_string()),
                _ => {}
            }

            // 2. Resolution Scaling (Do this early to save massive CPU on subsequent filters)
            if request.video_resolution != "Original" {
                let mut w = "-2".to_string();
                let mut h = "-2".to_string();

                if request.video_resolution == "Custom" {
                    w = if request.custom_width.is_empty() { "-2".to_string() } else { request.custom_width.clone() };
                    h = if request.custom_height.is_empty() { "-2".to_string() } else { request.custom_height.clone() };
                } else {
                    h = request.video_resolution.clone();
                }

                if w != "-2" || h != "-2" {
                    if request.maintain_aspect_ratio {
                        vfilters.push(format!("scale={}:{}", w, h));
                    } else {
                        let exact_w = if w == "-2" { "iw".to_string() } else { w };
                        let exact_h = if h == "-2" { "ih".to_string() } else { h };
                        vfilters.push(format!("scale={}:{}", exact_w, exact_h));
                    }
                }
            }

            // 3. Denoise
            match request.denoise.as_str() {
                "light" => vfilters.push("hqdn3d=1.5:1.5:6:6".to_string()),
                "medium" => vfilters.push("hqdn3d=3.0:3.0:6:6".to_string()),
                "strong" => vfilters.push("hqdn3d=5.0:5.0:6:6".to_string()),
                _ => {}
            }

            // 4. Sharpen
            match request.sharpen.as_str() {
                "light" => vfilters.push("unsharp=5:5:0.5:5:5:0.0".to_string()),
                "medium" => vfilters.push("unsharp=5:5:1.0:5:5:0.0".to_string()),
                "strong" => vfilters.push("unsharp=5:5:1.5:5:5:0.0".to_string()),
                _ => {}
            }

            // 4. Subtitle Burn-In (must be done before framerate manipulation if possible, or after)
            for sub in &request.subtitle_tracks {
                if sub.action == "burn" {
                    // Burn-in subtitle requires escaping the file path, but for simplicity we pass it directly
                    // Note: This requires the subtitle filter to have access to the file.
                    // A safe way for Windows paths in ffmpeg filters: replace \ with / and escape colons
                    let safe_path = request.input_path.replace("\\", "/").replace(":", "\\:");
                    vfilters.push(format!("subtitles='{}':si={}", safe_path, sub.input_index));
                }
            }

            // 5. Framerate / Interpolation (Most expensive, do this absolutely last on the scaled resolution)
            if !target_fps.is_empty() {
                if request.fps_mode == "interpolate" {
                    vfilters.push(format!("minterpolate=fps={}", target_fps));
                } else {
                    args.push("-r".to_string());
                    args.push(target_fps);
                }
            }

            if !vfilters.is_empty() {
                args.push("-filter:v:0".to_string());
                args.push(vfilters.join(","));
            }

            // Different encoders use different arguments for constant quality
            if !request.video_bitrate.is_empty() {
                args.push("-b:v".to_string());
                args.push(request.video_bitrate.clone());
            } else {
                if request.video_codec.contains("nvenc") {
                    args.push("-cq".to_string());
                    args.push(request.crf.to_string());
                } else if request.video_codec.contains("qsv") {
                    args.push("-global_quality".to_string());
                    args.push(request.crf.to_string());
                } else if request.video_codec.contains("amf") {
                    args.push("-qp_i".to_string());
                    args.push(request.crf.to_string());
                    args.push("-qp_p".to_string());
                    args.push(request.crf.to_string());
                } else {
                    args.push("-crf".to_string());
                    args.push(request.crf.to_string());
                }
            }
        }

        // Process audio tracks
        for (out_idx, track) in request.audio_tracks.iter().enumerate() {
            args.push("-map".to_string());
            args.push(format!("0:{}", track.input_index));

            if !track.title.is_empty() {
                args.push(format!("-metadata:s:a:{}", out_idx));
                args.push(format!("title={}", track.title));
            }

            if track.action == "copy" {
                args.push(format!("-c:a:{}", out_idx));
                args.push("copy".to_string());
            } else {
                args.push(format!("-c:a:{}", out_idx));
                
                let actual_codec = match track.codec.as_str() {
                    "flac_16" | "flac_24" => "flac",
                    "alac_16" | "alac_24" => "alac",
                    _ => track.codec.as_str(),
                };
                args.push(actual_codec.to_string());

                match track.codec.as_str() {
                    "flac_16" | "alac_16" => {
                        args.push(format!("-sample_fmt:a:{}", out_idx));
                        args.push(if track.codec == "alac_16" { "s16p".to_string() } else { "s16".to_string() });
                    },
                    "flac_24" | "alac_24" => {
                        args.push(format!("-sample_fmt:a:{}", out_idx));
                        args.push(if track.codec == "alac_24" { "s32p".to_string() } else { "s32".to_string() });
                    },
                    _ => {}
                }

                if track.bitrate != "auto" {
                    args.push(format!("-b:a:{}", out_idx));
                    args.push(track.bitrate.clone());
                }

                if track.sample_rate != "auto" {
                    args.push(format!("-ar:a:{}", out_idx));
                    args.push(track.sample_rate.clone());
                }

                let mut filters = Vec::new();

                if track.action == "upmix_51_discrete" {
                    // Use ffmpeg's native surround upmixer to derive 5.1 discrete channels from stereo
                    filters.push("surround=chl_out=5.1".to_string());
                } else if track.action == "upmix_dpl2" {
                    // Encode surround data into a 2-channel matrix for receiver decoding
                    filters.push("aresample=matrix_encoding=dplii".to_string());
                } else if track.action == "discrete_51" {
                    args.push(format!("-ac:a:{}", out_idx));
                    args.push("6".to_string());
                }

                if track.gain != 0.0 {
                    filters.push(format!("volume={}dB", track.gain));
                }

                if track.drc > 0.0 {
                    // Apply Dynamic Range Compression based on the 1.0 - 4.0 scale
                    filters.push(format!("acompressor=ratio={}:makeup={}", track.drc, track.drc * 1.5));
                }

                if track.normalize {
                    filters.push("loudnorm".to_string());
                }

                if !filters.is_empty() {
                    args.push(format!("-filter:a:{}", out_idx));
                    args.push(filters.join(","));
                }
            }
        }

        // Process subtitle tracks
        let mut sub_out_idx = 0;
        for sub in request.subtitle_tracks.iter() {
            if sub.action == "copy" {
                args.push("-map".to_string());
                args.push(format!("1:{}", sub.input_index));

                args.push(format!("-c:s:{}", sub_out_idx));
                args.push("copy".to_string());

                if !sub.title.is_empty() {
                    args.push(format!("-metadata:s:s:{}", sub_out_idx));
                    args.push(format!("title={}", sub.title));
                }

                if !sub.language.is_empty() {
                    args.push(format!("-metadata:s:s:{}", sub_out_idx));
                    args.push(format!("language={}", sub.language));
                }

                let mut disposition = Vec::new();
                if sub.is_default { disposition.push("default"); }
                if sub.is_forced { disposition.push("forced"); }
                
                if !disposition.is_empty() {
                    args.push(format!("-disposition:s:{}", sub_out_idx));
                    args.push(disposition.join("+"));
                } else {
                    // Explicitly remove default flag if not set
                    args.push(format!("-disposition:s:{}", sub_out_idx));
                    args.push("0".to_string());
                }
                
                sub_out_idx += 1;
            }
        }



        // Cover Art / Attachments
        let mut cover_idx_counter = 1; // Since 0 is usually main video
        for stream_idx in request.cover_art_tracks {
            args.push("-map".to_string());
            args.push(format!("0:{}", stream_idx));
            args.push(format!("-c:v:{}", cover_idx_counter));
            args.push("copy".to_string());
            args.push(format!("-disposition:v:{}", cover_idx_counter));
            args.push("attached_pic".to_string());
            cover_idx_counter += 1;
        }

        // Muxer flags to improve stability with fast-seeks or weird subtitle streams
        args.push("-max_muxing_queue_size".to_string());
        args.push("102400".to_string());

        args.push(request.output_path.clone());

        println!("Running ffmpeg with args: {:?}", args);

        let mut child = match Command::new("ffmpeg")
            .args(&args)
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("job-error", format!("Failed to spawn ffmpeg: {}", e));
                return;
            }
        };

        let pid = child.id();
        let state = app.state::<JobState>();
        *state.0.lock().unwrap() = Some(pid);

        let mut last_error_lines = std::collections::VecDeque::new();
        if let Some(mut stderr) = child.stderr.take() {
            let mut buffer = [0; 1024];
            let mut line_buf = String::new();
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 { break; }
                let s = String::from_utf8_lossy(&buffer[..n]);
                for c in s.chars() {
                    if c == '\r' || c == '\n' {
                        if !line_buf.is_empty() {
                            let _ = app.emit("job-progress", line_buf.clone());
                            if last_error_lines.len() >= 5 {
                                last_error_lines.pop_front();
                            }
                            last_error_lines.push_back(line_buf.clone());
                            line_buf.clear();
                        }
                    } else {
                        line_buf.push(c);
                    }
                }
            }
            if !line_buf.is_empty() {
                let _ = app.emit("job-progress", line_buf.clone());
                if last_error_lines.len() >= 5 {
                    last_error_lines.pop_front();
                }
                last_error_lines.push_back(line_buf);
            }
        }

        let status = child.wait().unwrap();
        
        let state = app.state::<JobState>();
        *state.0.lock().unwrap() = None;

        if status.success() {
            let _ = app.emit("job-success", request.output_path);
        } else {
            let error_msg = if last_error_lines.is_empty() {
                "FFmpeg job failed or was cancelled".to_string()
            } else {
                let joined = last_error_lines.into_iter().collect::<Vec<_>>().join(" | ");
                format!("FFmpeg failed: {}", joined)
            };
            let _ = app.emit("job-error", error_msg);
        }
    });

    Ok(())
}

#[tauri::command]
fn cancel_job(state: tauri::State<JobState>) -> Result<(), String> {
    if let Some(pid) = *state.0.lock().unwrap() {
        #[cfg(target_os = "windows")]
        let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status();
        #[cfg(not(target_os = "windows"))]
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
        
        *state.0.lock().unwrap() = None;
    }
    Ok(())
}

#[tauri::command]
fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
async fn get_encoders() -> Result<Vec<String>, String> {
    let output = Command::new("ffmpeg")
        .args(["-encoders"])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
        
    let output_str = String::from_utf8_lossy(&output.stdout);
    let mut encoders = Vec::new();
    
    // Look for common hardware encoders in the list
    if output_str.contains("nvenc") {
        encoders.push("NVENC (Nvidia)".to_string());
    }
    if output_str.contains("qsv") {
        encoders.push("QSV (Intel)".to_string());
    }
    if output_str.contains("amf") {
        encoders.push("AMF (AMD)".to_string());
    }
    if output_str.contains("videotoolbox") {
        encoders.push("VideoToolbox (Mac)".to_string());
    }
    
    Ok(encoders)
}

#[derive(Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub latest_version: String,
    pub release_notes: String,
    pub download_url: String,
}

#[tauri::command]
fn check_for_updates(current_version: String) -> Result<UpdateInfo, String> {
    let repo = "Karniverse/Kartix";
    // Fetch all releases (includes pre-releases) instead of just latest
    let url = format!("https://api.github.com/repos/{}/releases", repo);
    
    let resp = ureq::get(&url)
        .set("User-Agent", "Kartix-Updater")
        .call()
        .map_err(|e| format!("Failed to fetch updates: {}", e))?;
        
    let json: serde_json::Value = resp.into_json()
        .map_err(|e| format!("Invalid JSON response: {}", e))?;
        
    // GitHub returns an array of releases, sorted by newest first
    let latest_release = json.as_array()
        .and_then(|arr| arr.first())
        .ok_or("No releases found")?;
        
    let tag_name = latest_release["tag_name"].as_str().unwrap_or("").to_string();
    let body = latest_release["body"].as_str().unwrap_or("").to_string();
    
    // Find MSI asset
    let mut download_url = String::new();
    if let Some(assets) = latest_release["assets"].as_array() {
        for asset in assets {
            if let Some(name) = asset["name"].as_str() {
                if name.ends_with(".msi") {
                    download_url = asset["browser_download_url"].as_str().unwrap_or("").to_string();
                    break;
                }
            }
        }
    }
    
    let mut latest_version = tag_name.clone();
    if latest_version.starts_with('v') || latest_version.starts_with('V') {
        latest_version = latest_version[1..].trim().to_string();
    }
    
    let mut current = current_version.clone();
    if current.starts_with('v') || current.starts_with('V') {
        current = current[1..].trim().to_string();
    }
    
    let available = !latest_version.is_empty() && latest_version != current && !download_url.is_empty();
    
    Ok(UpdateInfo {
        available,
        latest_version: tag_name,
        release_notes: body,
        download_url,
    })
}

#[tauri::command]
fn download_and_install_update(url: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let msi_path = temp_dir.join("Kartix_Update.msi");
    
    let resp = ureq::get(&url)
        .set("User-Agent", "Kartix-Updater")
        .call()
        .map_err(|e| format!("Download failed: {}", e))?;
        
    let mut file = std::fs::File::create(&msi_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
        
    std::io::copy(&mut resp.into_reader(), &mut file)
        .map_err(|e| format!("Failed to write file: {}", e))?;
        
    // Spawn MSI installer detached
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", msi_path.to_str().unwrap()])
            .spawn()
            .map_err(|e| format!("Failed to start installer: {}", e))?;
    }
    
    // Exit current app so installer can overwrite it
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(JobState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            analyze_file, 
            start_job, 
            get_encoders, 
            check_file_exists, 
            cancel_job,
            check_for_updates,
            download_and_install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
