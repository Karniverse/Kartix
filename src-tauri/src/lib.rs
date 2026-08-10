use std::process::{Command, Stdio};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use tauri::{AppHandle, Emitter};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Serialize, Deserialize, Debug)]
pub struct MediaInfo {
    pub file_path: String,
    pub format: serde_json::Value,
    pub streams: serde_json::Value,
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
pub struct JobRequest {
    pub input_path: String,
    pub output_path: String,
    pub video_codec: String, // e.g., "libx264", "hevc_nvenc"
    pub crf: u8,
    pub audio_tracks: Vec<AudioTrackConfig>,
}

#[tauri::command]
async fn analyze_file(file_path: String) -> Result<MediaInfo, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            &file_path,
        ])
        .output()
        .map_err(|e| format!("Failed to execute ffprobe: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe error: {}", err));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let mut parsed: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    Ok(MediaInfo {
        file_path,
        format: parsed["format"].take(),
        streams: parsed["streams"].take(),
    })
}

#[tauri::command]
fn start_job(app: AppHandle, request: JobRequest) -> Result<(), String> {
    thread::spawn(move || {
        let mut args = vec![
            "-y".to_string(), // overwrite output
            "-i".to_string(), request.input_path.clone(),
        ];

        // Map video
        args.push("-map".to_string());
        args.push("0:v:0".to_string());
        args.push("-c:v".to_string());
        args.push(request.video_codec.clone());
        if request.video_codec != "copy" {
            // Different encoders use different arguments for constant quality
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

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    // Just emit the raw line for now, frontend can parse time/frame
                    let _ = app.emit("job-progress", line);
                }
            }
        }

        let status = child.wait().unwrap();
        if status.success() {
            let _ = app.emit("job-success", request.output_path);
        } else {
            let _ = app.emit("job-error", "FFmpeg job failed".to_string());
        }
    });

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![analyze_file, start_job, get_encoders, check_file_exists])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
