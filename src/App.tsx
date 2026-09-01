import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from '@tauri-apps/plugin-opener';
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import versionData from "./version.json";

function App() {
  const [activeTab, setActiveTab] = useState("audio");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [mediaInfo, setMediaInfo] = useState<any>(null);
  const [encoders, setEncoders] = useState<string[]>([]);
  const [jobStatus, setJobStatus] = useState<string>("No active jobs.");
  const [outputPath, setOutputPath] = useState<string>("");

  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };
  
  // Settings State
  const [videoCodec, setVideoCodec] = useState("libx264");
  const [qualityMode, setQualityMode] = useState("crf");
  const [crf, setCrf] = useState(22);
  const [videoBitrate, setVideoBitrate] = useState("5000"); // in kbps
  const [audioConfigs, setAudioConfigs] = useState<any[]>([]);
  const [subtitleConfigs, setSubtitleConfigs] = useState<any[]>([]);
  const [autoChapterInterval, setAutoChapterInterval] = useState(300);
  
  const [chapters, setChapters] = useState<any[]>([]);
  const [keepChapters, setKeepChapters] = useState(true);
  const [keepCoverArt, setKeepCoverArt] = useState(true);
  const [coverArtTracks, setCoverArtTracks] = useState<number[]>([]);

  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd] = useState("");
  const [playhead, setPlayhead] = useState(0);

  // Video Advanced State
  const [videoResolution, setVideoResolution] = useState("Original");
  const [customWidth, setCustomWidth] = useState("");
  const [customHeight, setCustomHeight] = useState("");
  const [maintainAspectRatio, setMaintainAspectRatio] = useState(true);
  
  const [videoFps, setVideoFps] = useState("Original");
  const [customFps, setCustomFps] = useState("");
  const [fpsMode, setFpsMode] = useState("standard");
  
  const [pixelFormat, setPixelFormat] = useState("auto");
  const [deinterlace, setDeinterlace] = useState("off");
  const [denoise, setDenoise] = useState("off");
  const [sharpen, setSharpen] = useState("off");

  // Enforce pixel format constraints based on codec
  useEffect(() => {
    const isH264 = videoCodec.includes("h264") || videoCodec === "libx264";
    if (isH264 && pixelFormat === "yuv420p10le") {
      // Hardware H.264 encoders crash on 10-bit input. Force to 8-bit.
      setPixelFormat("yuv420p");
    }
  }, [videoCodec, pixelFormat]);

  useEffect(() => {
    invoke<string[]>("get_encoders").then(encs => {
      setEncoders(encs);
      if (encs.some(e => e.includes("NVENC"))) setVideoCodec("h264_nvenc");
      else if (encs.some(e => e.includes("QSV"))) setVideoCodec("h264_qsv");
      else if (encs.some(e => e.includes("AMF"))) setVideoCodec("h264_amf");
      else if (encs.some(e => e.includes("VideoToolbox"))) setVideoCodec("h264_videotoolbox");
    }).catch(console.error);

    // Check for updates silently in background
    invoke<any>("check_for_updates").then(info => {
      if (info?.available) {
        setUpdateInfo(info);
      }
    }).catch(() => {});

    const unlistenSuccess = listen("job-success", (event) => {
      setJobStatus(`Job Completed successfully! Saved to: ${event.payload}`);
    });
    
    const unlistenError = listen("job-error", (event) => {
      setJobStatus(`Job Failed: ${event.payload}`);
    });

    const unlistenProgress = listen("job-progress", (event) => {
      const line = event.payload as string;
      
      // Check for progress
      if (line.includes("time=")) {
        const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}.\d{2})/);
        const fpsMatch = line.match(/fps=\s*([\d.]+)/);
        const speedMatch = line.match(/speed=\s*([\d.]+)x/);
        
        let status = "Processing...";
        if (timeMatch) status += ` Time: ${timeMatch[1]}`;
        if (fpsMatch) status += ` | FPS: ${fpsMatch[1]}`;
        if (speedMatch) status += ` | Speed: ${speedMatch[1]}x`;
        
        setJobStatus(status);
      } else if (line.toLowerCase().includes("error") || line.toLowerCase().includes("failed") || line.toLowerCase().includes("no capable devices")) {
        setJobStatus((prev) => prev.startsWith("Job Failed") ? prev : `FFmpeg Error: ${line}`);
      } else if (line.trim() !== "" && !line.startsWith("frame=")) {
        // Show initialization logs to show it's not stuck
        setJobStatus((prev) => {
          if (prev.startsWith("Processing")) return prev;
          if (line.length > 80) return `Init: ${line.substring(0, 80)}...`;
          return `Init: ${line}`;
        });
      }
    });

    return () => {
      unlistenSuccess.then(f => f());
      unlistenError.then(f => f());
      unlistenProgress.then(f => f());
    };
  }, []);

  const handleOpenFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Video',
          extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm']
        }]
      });
      if (selected) {
        setFilePath(selected as string);
        setJobStatus("Analyzing file...");
        const info = await invoke("analyze_file", { filePath: selected });
        setMediaInfo(info);
        setJobStatus("File loaded.");
        
        // Set default output path
        const isWin = selected.includes('\\');
        const pathParts = selected.split(isWin ? '\\' : '/');
        const fileName = pathParts.pop() || "output";
        const dir = pathParts.join(isWin ? '\\' : '/');
        const extMatch = fileName.match(/\.[^.]+$/);
        const ext = extMatch ? extMatch[0] : ".mkv";
        const baseName = fileName.replace(ext, "");
        setOutputPath(`${dir}${isWin ? '\\' : '/'}${baseName} - converted.mkv`);

        // Initialize audio configs based on streams
        if (info && (info as any).streams) {
          const aConfigs = ((info as any).streams as any[])
            .filter((s: any) => s.codec_type === 'audio')
            .map((s: any) => {
              const lang = s.tags?.language ? s.tags.language.toUpperCase() : "UND";
              const isCopy = s.channels === 6;
              const outCodec = isCopy ? (s.codec_name ? s.codec_name.toUpperCase() : "UNKNOWN") : "AAC";
              const outCh = isCopy ? "5.1" : (s.channels === 2 ? "5.1" : s.channels);
              const layout = outCh === "5.1" ? "Surround" : s.channels === 2 ? "Stereo" : `${s.channels}ch`;
              
              return {
                input_index: s.index,
                action: isCopy ? "copy" : s.channels === 2 ? "upmix_dpl2" : "copy",
                codec: "aac",
                normalize: false,
                gain: 0,
                drc: 0,
                enabled: true,
                title: `${lang} - ${layout} - ${outCodec} - ${outCh}`,
                bitrate: "auto",
                sample_rate: "auto",
                _channels: s.channels,
                source_codec: s.codec_name ? s.codec_name.toUpperCase() : "UNKNOWN",
                source_lang: s.tags?.language ? s.tags.language.toUpperCase() : "",
                source_bitrate: s.bit_rate || s.tags?.BPS || s.tags?.['BPS-eng'],
                source_sample_rate: s.sample_rate
              };
            });
          setAudioConfigs(aConfigs);

          // Initialize subtitle configs based on streams
          const sConfigs = ((info as any).streams as any[])
            .filter((s: any) => s.codec_type === 'subtitle')
            .map((s: any) => {
              const lang = s.tags?.language ? s.tags.language.toUpperCase() : "UND";
              const title = s.tags?.title || `${lang}-Sub`;
              return {
                input_index: s.index,
                title: title,
                action: "copy", // "copy", "burn", "none"
                language: lang,
                is_default: s.disposition?.default === 1,
                is_forced: s.disposition?.forced === 1,
                codec_name: s.codec_name
              };
            });
          setSubtitleConfigs(sConfigs);

          // Detect attached pictures (cover art)
          const cTracks = ((info as any).streams as any[])
            .filter((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic === 1)
            .map((s: any) => s.index);
          setCoverArtTracks(cTracks);

          // Parse Chapters
          if ((info as any).chapters) {
            const chaps = ((info as any).chapters as any[]).map((ch: any) => ({
              id: ch.id,
              start_time: parseFloat(ch.start_time),
              end_time: parseFloat(ch.end_time),
              title: ch.tags?.title || `Chapter ${ch.id}`
            }));
            setChapters(chaps);
          } else {
            setChapters([]);
          }
        }
      }
    } catch (err) {
      console.error(err);
      setJobStatus(`Error: ${err}`);
    }
  };

  const handleCheckUpdates = async () => {
    setIsCheckingUpdate(true);
    setUpdateInfo(null);
    try {
      const info = await invoke<any>("check_for_updates");
      setUpdateInfo(info);
    } catch (err) {
      console.error(err);
      alert(`Failed to check for updates: ${err}`);
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleDownloadUpdate = async () => {
    if (!updateInfo || !updateInfo.download_url) return;
    setIsUpdating(true);
    try {
      await invoke("download_and_install_update", { url: updateInfo.download_url });
    } catch (err) {
      console.error(err);
      alert(`Failed to download update: ${err}`);
      setIsUpdating(false);
    }
  };

  const handleStart = async () => {
    if (!filePath || !mediaInfo || !outputPath) return;
    
    try {
      const exists = await invoke<boolean>("check_file_exists", { path: outputPath });
      if (exists) {
        if (!window.confirm(`The file "${outputPath.split(/[\/\\]/).pop()}" already exists.\n\nDo you want to overwrite it?`)) {
          return;
        }
      }

      setJobStatus("Starting job...");
      
      const request = {
        input_path: filePath,
        output_path: outputPath,
        video_codec: videoCodec,
        crf: Number(crf),
        video_bitrate: qualityMode === 'bitrate' ? `${videoBitrate}k` : "",
        video_resolution: videoResolution,
        custom_width: customWidth,
        custom_height: customHeight,
        maintain_aspect_ratio: maintainAspectRatio,
        video_fps: videoFps,
        custom_fps: customFps,
        fps_mode: fpsMode,
        pixel_format: pixelFormat,
        deinterlace: deinterlace,
        denoise: denoise,
        sharpen: sharpen,
        audio_tracks: audioConfigs.filter(c => c.enabled).map(c => ({
          input_index: c.input_index,
          title: c.title,
          action: c.action,
          codec: c.codec,
          bitrate: c.bitrate,
          sample_rate: c.sample_rate,
          normalize: c.normalize,
          gain: c.gain,
          drc: c.drc
        })),
        subtitle_tracks: subtitleConfigs.filter(c => c.action !== "none").map(c => ({
          input_index: c.input_index,
          title: c.title,
          action: c.action,
          language: c.language,
          is_default: c.is_default,
          is_forced: c.is_forced
        })),
        keep_chapters: keepChapters,
        custom_chapters: chapters,
        cover_art_tracks: keepCoverArt ? coverArtTracks : [],
        trim_start: trimStart,
        trim_end: trimEnd,
      };

      await invoke("start_job", { request });
    } catch (err) {
      console.error(err);
      setJobStatus(`Failed to start job: ${err}`);
    }
  };

  const handleCancel = async () => {
    try {
      await invoke("cancel_job");
      setJobStatus("Job Cancelled");
    } catch (err) {
      console.error(err);
    }
  };

  const handleBrowseOutput = async () => {
    const outPath = await save({
      filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'avi', 'mov', 'webm'] }]
    });
    if (outPath) setOutputPath(outPath);
  };

  const handleOpenFolder = async () => {
    if (!outputPath) return;
    try {
      // Extract directory path by removing the filename
      const folderPath = outputPath.substring(0, Math.max(outputPath.lastIndexOf('\\'), outputPath.lastIndexOf('/')));
      if (folderPath) {
        await openPath(folderPath);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const updateAudioConfig = (index: number, key: string, value: any) => {
    const newConfigs = [...audioConfigs];
    newConfigs[index][key] = value;
    setAudioConfigs(newConfigs);
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar glass-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '2rem' }}>
          <div style={{ width: '32px', height: '32px', background: 'var(--accent-color)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>K</div>
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Kartix Convert</h2>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={handleOpenFile} style={{ justifyContent: 'flex-start', border: 'none' }}>
            📁 Open File
          </button>
        </nav>

        {mediaInfo?.streams && (
          <div style={{ marginTop: '1.5rem', flex: 1, overflowY: 'auto', paddingRight: '0.5rem' }}>
            <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Source Tracks</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.75rem' }}>
              {(mediaInfo.streams as any[]).map((stream: any) => {
                const formatBitrate = (br: any) => br ? `${Math.round(Number(br)/1000)} kbps` : null;
                const getBitrate = (s: any) => s.bit_rate || s.tags?.BPS || s.tags?.['BPS-eng'];
                const bitrate = getBitrate(stream);
                
                const formatFps = (fr: any) => {
                  if (!fr || fr === "0/0") return null;
                  const [n, d] = fr.split('/');
                  return d ? `${(Number(n)/Number(d)).toFixed(3)} FPS` : `${fr} FPS`;
                };

                return (
                <div key={stream.index} style={{ background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '6px', borderLeft: `3px solid ${stream.codec_type === 'video' ? (stream.disposition?.attached_pic ? '#9b59b6' : '#4a9eff') : stream.codec_type === 'audio' ? '#2ecc71' : '#f1c40f'}` }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>
                    #{stream.index} - {Boolean(stream.disposition?.attached_pic) ? 'COVER ART' : stream.codec_type.toUpperCase()}
                  </div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '0.1rem', color: 'var(--text-secondary)' }}>
                    <div>Format:</div><div style={{ color: 'var(--text-primary)' }}>{stream.codec_name?.toUpperCase()} {stream.profile ? `(${stream.profile})` : ''}</div>
                    
                    {stream.codec_type === 'video' && !Boolean(stream.disposition?.attached_pic) && (
                      <>
                        <div>Resolution:</div><div style={{ color: 'var(--text-primary)' }}>{stream.width}x{stream.height}</div>
                        <div>Framerate:</div><div style={{ color: 'var(--text-primary)' }}>{formatFps(stream.r_frame_rate) || 'Unknown'}</div>
                        {Boolean(stream.pix_fmt) && <><div title="Pixel Format / Chroma Subsampling">Color:</div><div style={{ color: 'var(--text-primary)' }}>{stream.pix_fmt.toUpperCase()}</div></>}
                        {Boolean(stream.bits_per_raw_sample) && <><div title="Bit Depth">Bit Depth:</div><div style={{ color: 'var(--text-primary)' }}>{stream.bits_per_raw_sample} bits</div></>}
                        {Boolean(stream.color_space) && <><div title="Color Space">Color Space:</div><div style={{ color: 'var(--text-primary)' }}>{stream.color_space.toUpperCase()} {stream.color_transfer === 'smpte2084' ? '(HDR PQ)' : ''}</div></>}
                      </>
                    )}
                    
                    {stream.codec_type === 'video' && Boolean(stream.disposition?.attached_pic) && (
                      <>
                        <div>Resolution:</div><div style={{ color: 'var(--text-primary)' }}>{stream.width}x{stream.height}</div>
                        <div>Attachment:</div><div style={{ color: 'var(--text-primary)' }}>Yes</div>
                      </>
                    )}

                    {stream.codec_type === 'audio' && (
                      <>
                        <div>Channels:</div><div style={{ color: 'var(--text-primary)' }}>{stream.channels} ({stream.channel_layout || 'unknown'})</div>
                        <div>Sampling:</div><div style={{ color: 'var(--text-primary)' }}>{stream.sample_rate} Hz</div>
                      </>
                    )}

                    {stream.codec_type === 'subtitle' && (
                      <>
                        <div>Type:</div><div style={{ color: 'var(--text-primary)' }}>{stream.codec_name === 'hdmv_pgs_subtitle' ? 'PGS (Bitmap)' : stream.codec_name === 'subrip' ? 'SRT (Text)' : stream.codec_name === 'ass' ? 'ASS (Text)' : stream.codec_name}</div>
                      </>
                    )}

                    {stream.codec_type !== 'subtitle' && (
                      <><div title="Bitrate">Bitrate:</div><div style={{ color: 'var(--text-primary)' }}>{formatBitrate(bitrate) || 'Unknown'}</div></>
                    )}
                    
                    {Boolean(stream.tags?.language) && (
                      <><div title="Language">Language:</div><div style={{ color: 'var(--text-primary)' }}>{stream.tags.language.toUpperCase()}</div></>
                    )}
                    
                    {(stream.disposition?.default === 1 || stream.disposition?.forced === 1) && (
                      <><div title="Flags">Flags:</div><div style={{ color: 'var(--text-primary)' }}>{[stream.disposition?.default ? "Default" : null, stream.disposition?.forced ? "Forced" : null].filter(Boolean).join(", ")}</div></>
                    )}
                  </div>

                  {stream.tags?.title && (
                    <div style={{ color: 'var(--text-secondary)', marginTop: '0.35rem', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={stream.tags.title}>
                      "{stream.tags.title}"
                    </div>
                  )}
                </div>
              )})}
            </div>
          </div>
        )}

        <div style={{ marginTop: 'auto' }}>
          {jobStatus.startsWith("Processing") || jobStatus.startsWith("Init") || jobStatus === "Starting job..." ? (
            <button className="btn" onClick={handleCancel} style={{ width: '100%', padding: '0.75rem', background: 'var(--danger-color)', color: 'white', border: 'none', cursor: 'pointer' }}>
              🛑 Cancel Job
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleStart} disabled={!filePath} style={{ width: '100%', padding: '0.75rem', opacity: filePath ? 1 : 0.5 }}>
              🚀 Start Conversion
            </button>
          )}
            <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
              {updateInfo?.available ? (
                <div style={{ background: 'rgba(46, 204, 113, 0.1)', padding: '0.75rem', borderRadius: '6px', border: '1px solid #2ecc71', fontSize: '0.8rem' }}>
                  <div style={{ fontWeight: 'bold', color: '#2ecc71', marginBottom: '0.25rem' }}>Update Available! ({updateInfo.latest_version})</div>
                  <button 
                    className="btn btn-primary" 
                    onClick={handleDownloadUpdate} 
                    disabled={isUpdating}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.5rem', fontSize: '0.8rem' }}
                  >
                    {isUpdating ? "Downloading..." : "Install Update"}
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    v{versionData.version}
                  </div>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleCheckUpdates} 
                    disabled={isCheckingUpdate}
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.7rem' }}
                  >
                    {isCheckingUpdate ? "..." : "Check Update"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>

      {/* Main Content Area */}
      <main className="main-content">
        
        {/* Top Info Bar */}
        <header className="top-bar glass-panel">
          <div>
            <h3 style={{ margin: 0 }}>{filePath ? filePath.split('\\').pop()?.split('/').pop() : 'No File Selected'}</h3>
            <p style={{ margin: 0 }}>{mediaInfo ? `${(mediaInfo as any).format.format_long_name}` : 'Select a file to begin'}</p>
          </div>
          {mediaInfo && (
            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Duration</span>
                <div style={{ fontWeight: '500' }}>{Math.round(Number((mediaInfo as any).format.duration) / 60)} min</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Size</span>
                <div style={{ fontWeight: '500' }}>{(Number((mediaInfo as any).format.size) / (1024*1024)).toFixed(1)} MB</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Bitrate</span>
                <div style={{ fontWeight: '500' }}>{(mediaInfo as any).format.bit_rate ? `${Math.round(Number((mediaInfo as any).format.bit_rate) / 1000)} kbps` : 'Unknown'}</div>
              </div>
            </div>
          )}
        </header>

        {/* Media Settings Viewer */}
        <section className="media-viewer glass-panel">
          <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', marginBottom: '1rem', display: 'flex', gap: '1rem' }}>
            <nav className="tabs">
              <button className={`btn ${activeTab === 'video' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('video')}>Video</button>
              <button className={`btn ${activeTab === 'audio' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('audio')}>Audio</button>
              <button className={`btn ${activeTab === 'subtitles' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('subtitles')}>Subtitles</button>
              <button className={`btn ${activeTab === 'metadata' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('metadata')}>Chapters & Metadata</button>
              <button className={`btn ${activeTab === 'trim' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('trim')}>Trim</button>
            </nav>
          </div>

          <div className="settings-panel">
            {activeTab === 'audio' && audioConfigs.length > 0 && audioConfigs.map((track, idx) => (
               <div className="settings-card" key={idx}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>
                      SOURCE: {track.source_codec}
                    </span>
                    {track.source_lang && (
                      <span style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                        LANG: {track.source_lang}
                      </span>
                    )}
                    {track.source_sample_rate && (
                      <span style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                        {Math.round(track.source_sample_rate / 1000)}kHz
                      </span>
                    )}
                    <span style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                      {track.source_bitrate ? `${Math.round(track.source_bitrate / 1000)} kbps` : 'Unknown kbps'}
                    </span>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input 
                      type="checkbox" 
                      checked={track.enabled} 
                      onChange={(e) => updateAudioConfig(idx, 'enabled', e.target.checked)} 
                    />
                    <span style={{ fontSize: '0.875rem', fontWeight: 'bold', color: track.enabled ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                      {track.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                </div>
                
                <div style={{ opacity: track.enabled ? 1 : 0.4, pointerEvents: track.enabled ? 'auto' : 'none', transition: 'all 0.2s' }}>
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      Track Name
                    </label>
                  <input 
                    type="text" 
                    className="input-field" 
                    value={track.title} 
                    onChange={(e) => updateAudioConfig(idx, 'title', e.target.value)}
                    style={{ fontWeight: 'bold' }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Action</label>
                    <select 
                      className="input-field" 
                      value={track.action}
                      onChange={(e) => updateAudioConfig(idx, 'action', e.target.value)}
                    >
                      <option value="copy">Pass-through (Copy)</option>
                      <option value="discrete_51">Convert & Keep Discrete (5.1)</option>
                      <option value="upmix_51_discrete">Software Upmix (Discrete 5.1 Channels)</option>
                      <option value="upmix_dpl2">Software Upmix (ProLogic II Stereo Matrix)</option>
                      <option value="convert">Convert (Standard)</option>
                    </select>
                  </div>
                  {track.action !== 'copy' && (
                    <>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Codec</label>
                          <select 
                            className="input-field"
                            value={track.codec}
                            onChange={(e) => {
                              updateAudioConfig(idx, 'codec', e.target.value);
                              updateAudioConfig(idx, 'bitrate', 'auto');
                            }}
                          >
                            <option value="aac">AAC</option>
                            <option value="ac3">AC3</option>
                            <option value="eac3">E-AC3</option>
                            <option value="truehd">TrueHD</option>
                            <option value="libmp3lame">MP3</option>
                            <option value="libopus">Opus</option>
                            <option value="libvorbis">Vorbis</option>
                            <option value="flac_16">FLAC 16-bit</option>
                            <option value="flac_24">FLAC 24-bit</option>
                            <option value="alac_16">ALAC 16-bit</option>
                            <option value="alac_24">ALAC 24-bit</option>
                            <option value="pcm_s16le">PCM 16-bit</option>
                            <option value="pcm_s24le">PCM 24-bit</option>
                          </select>
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Bitrate</label>
                          <select 
                            className="input-field"
                            value={track.bitrate}
                            onChange={(e) => updateAudioConfig(idx, 'bitrate', e.target.value)}
                            disabled={["truehd", "flac_16", "flac_24", "alac_16", "alac_24", "pcm_s16le", "pcm_s24le"].includes(track.codec)}
                          >
                            <option value="auto">auto</option>
                            {track.codec === 'aac' && ["64k", "96k", "128k", "192k", "256k", "320k", "448k", "512k", "640k"].map(b => <option key={b} value={b}>{b}</option>)}
                            {track.codec === 'ac3' && ["192k", "224k", "256k", "320k", "384k", "448k", "512k", "640k"].map(b => <option key={b} value={b}>{b}</option>)}
                            {track.codec === 'eac3' && ["192k", "256k", "320k", "384k", "448k", "512k", "640k", "768k", "1024k", "1536k", "2048k"].map(b => <option key={b} value={b}>{b}</option>)}
                            {track.codec === 'libopus' && ["64k", "96k", "128k", "192k", "256k", "320k", "512k"].map(b => <option key={b} value={b}>{b}</option>)}
                            {track.codec === 'libmp3lame' && ["64k", "96k", "128k", "192k", "256k", "320k"].map(b => <option key={b} value={b}>{b}</option>)}
                            {track.codec === 'libvorbis' && ["64k", "96k", "128k", "192k", "256k", "320k", "512k"].map(b => <option key={b} value={b}>{b}</option>)}
                          </select>
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Sample Rate</label>
                          <select 
                            className="input-field"
                            value={track.sample_rate}
                            onChange={(e) => updateAudioConfig(idx, 'sample_rate', e.target.value)}
                          >
                            <option value="auto">auto</option>
                            <option value="44100">44100</option>
                            <option value="48000">48000</option>
                            <option value="96000">96000</option>
                          </select>
                        </div>
                      </div>
                      
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Gain (dB)</label>
                          <input 
                            type="number" 
                            className="input-field" 
                            value={track.gain}
                            onChange={(e) => updateAudioConfig(idx, 'gain', Number(e.target.value))}
                            step="0.5"
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }} title="Dynamic Range Compression. 0 = Disabled. Handbrake scale: 1.0 - 4.0">DRC Level (0-4)</label>
                          <input 
                            type="number" 
                            className="input-field" 
                            value={track.drc}
                            onChange={(e) => updateAudioConfig(idx, 'drc', Number(e.target.value))}
                            step="0.1"
                            min="0"
                            max="4"
                          />
                        </div>
                      </div>

                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem', cursor: 'pointer' }} title="EBU R128 measures perceived loudness across the whole track and adjusts it to a standard broadcast level (-23 LUFS), ensuring consistent volume without just clipping peaks like standard peak normalization.">
                        <input 
                          type="checkbox" 
                          checked={track.normalize}
                          onChange={(e) => updateAudioConfig(idx, 'normalize', e.target.checked)}
                        />
                        <span style={{ fontSize: '0.875rem' }}>Loudness Normalization (EBU R128)</span>
                      </label>
                    </>
                  )}
                </div>
                </div>
              </div>
            ))}
            {activeTab === 'audio' && audioConfigs.length === 0 && (
              <div style={{ color: 'var(--text-secondary)' }}>No audio tracks found or file not loaded.</div>
            )}

            {activeTab === 'video' && (() => {
              const videoStream = mediaInfo?.streams?.find((s: any) => s.codec_type === 'video');
              const fpsParts = videoStream?.r_frame_rate?.split('/');
              const fps = fpsParts && fpsParts.length === 2 ? (parseInt(fpsParts[0]) / parseInt(fpsParts[1])).toFixed(2) : videoStream?.r_frame_rate;
              const sourceVideoBitrate = videoStream?.bit_rate || videoStream?.tags?.BPS || videoStream?.tags?.['BPS-eng'];
              
              return (
                <>
                  {videoStream && (
                    <div className="settings-card" style={{ marginBottom: '1rem', background: 'rgba(255,255,255,0.05)', gridColumn: '1 / -1' }}>
                      <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Source Video Details</h4>
                      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                        <span style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>
                          CODEC: {videoStream.codec_name?.toUpperCase()}
                        </span>
                        <span style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                          RES: {videoStream.width}x{videoStream.height}
                        </span>
                        <span style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                          BITRATE: {sourceVideoBitrate ? `${Math.round(sourceVideoBitrate / 1000)} kbps` : 'Unknown kbps'}
                        </span>
                        {fps && (
                          <span style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                            FPS: {fps}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="settings-card" style={{ marginBottom: '1rem' }}>
                    <h4>Dimensions & Framerate</h4>
                    <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Resolution</label>
                        <select className="input-field" value={videoResolution} onChange={(e) => setVideoResolution(e.target.value)}>
                          <option value="Original">Original</option>
                          <option value="2160">2160p (4K)</option>
                          <option value="1440">1440p (2K)</option>
                          <option value="1080">1080p (FHD)</option>
                          <option value="720">720p (HD)</option>
                          <option value="480">480p (SD)</option>
                          <option value="Custom">Custom</option>
                        </select>
                      </div>
                      <div style={{ flex: 1, opacity: videoResolution === 'Custom' ? 1 : 0.5, pointerEvents: videoResolution === 'Custom' ? 'auto' : 'none' }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Width x Height</label>
                        <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                          <input type="number" className="input-field" placeholder="W" value={customWidth} onChange={(e) => setCustomWidth(e.target.value)} />
                          <span>x</span>
                          <input type="number" className="input-field" placeholder="H" value={customHeight} onChange={(e) => setCustomHeight(e.target.value)} />
                        </div>
                      </div>
                    </div>
                    {videoResolution !== 'Original' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', cursor: 'pointer' }}>
                        <input type="checkbox" checked={maintainAspectRatio} onChange={(e) => setMaintainAspectRatio(e.target.checked)} />
                        <span style={{ fontSize: '0.875rem' }}>Maintain Aspect Ratio (Proportional Width)</span>
                      </label>
                    )}

                    <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Framerate (FPS)</label>
                        <select className="input-field" value={videoFps} onChange={(e) => setVideoFps(e.target.value)}>
                          <option value="Original">Original</option>
                          <option value="23.976">23.976 (Film)</option>
                          <option value="24">24</option>
                          <option value="25">25 (PAL)</option>
                          <option value="29.97">29.97 (NTSC)</option>
                          <option value="30">30</option>
                          <option value="59.94">59.94</option>
                          <option value="60">60</option>
                          <option value="Custom">Custom</option>
                        </select>
                        {videoFps === 'Custom' && (
                          <input type="number" className="input-field" placeholder="Custom FPS" value={customFps} onChange={(e) => setCustomFps(e.target.value)} style={{ marginTop: '0.5rem' }} />
                        )}
                      </div>
                      <div style={{ flex: 1, opacity: videoFps === 'Original' ? 0.5 : 1, pointerEvents: videoFps === 'Original' ? 'none' : 'auto' }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }} title="Motion Interpolation takes longer but generates artificial frames for a smoother upframe experience.">Mode</label>
                        <select className="input-field" value={fpsMode} onChange={(e) => setFpsMode(e.target.value)}>
                          <option value="standard">Standard (Drop/Duplicate)</option>
                          <option value="interpolate">Motion Interpolation (Blend)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="settings-card" style={{ marginBottom: '1rem' }}>
                    <h4>Video Filters</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
                      <div>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Deinterlace</label>
                        <select className="input-field" value={deinterlace} onChange={(e) => setDeinterlace(e.target.value)}>
                          <option value="off">Off</option>
                          <option value="bwdif">Default (BWDIF)</option>
                          <option value="yadif">YADIF</option>
                          <option value="bwdif_bob">Bob (Double Framerate)</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: '1rem' }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Denoise (NLMeans / HQDN3D)</label>
                          <select className="input-field" value={denoise} onChange={(e) => setDenoise(e.target.value)}>
                            <option value="off">Off</option>
                            <option value="light">Light</option>
                            <option value="medium">Medium</option>
                            <option value="strong">Strong</option>
                          </select>
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Sharpen (Unsharp)</label>
                          <select className="input-field" value={sharpen} onChange={(e) => setSharpen(e.target.value)}>
                            <option value="off">Off</option>
                            <option value="light">Light</option>
                            <option value="medium">Medium</option>
                            <option value="strong">Strong</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="settings-card" style={{ gridColumn: '1 / -1' }}>
                    <h4>Video Encoding</h4>
                    <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Codec & HW Accel</label>
                        <select 
                          className="input-field"
                          value={videoCodec}
                          onChange={(e) => setVideoCodec(e.target.value)}
                        >
                          <option value="libx264">H.264 (Software)</option>
                          <option value="libx265">H.265 / HEVC (Software)</option>
                          <option value="libaom-av1">AV1 (Software)</option>
                          <option disabled>--- Hardware Encoders ---</option>
                          {encoders.map(e => {
                             if (e.includes("NVENC")) return <><option value="h264_nvenc">H.264 (NVENC)</option><option value="hevc_nvenc">H.265 (NVENC)</option></>;
                             if (e.includes("QSV")) return <><option value="h264_qsv">H.264 (QSV)</option><option value="hevc_qsv">H.265 (QSV)</option></>;
                             if (e.includes("AMF")) return <><option value="h264_amf">H.264 (AMF)</option><option value="hevc_amf">H.265 (AMF)</option></>;
                             return null;
                          })}
                          <option value="copy">Pass-through (Copy Video)</option>
                        </select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }} title="Fixes encoder crashes by explicitly converting color bit depth.">Pixel Format</label>
                        <select className="input-field" value={pixelFormat} onChange={(e) => setPixelFormat(e.target.value)} disabled={videoCodec === 'copy'}>
                          <option value="auto">Auto (Copy Source)</option>
                          <option value="yuv420p">8-bit (SDR / H.264 Compatible)</option>
                          {!(videoCodec.includes("h264") || videoCodec === "libx264") && (
                            <option value="yuv420p10le">10-bit (HDR / HEVC Recommended)</option>
                          )}
                        </select>
                        {(videoCodec.includes("h264") || videoCodec === "libx264") && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                            10-bit is unsupported by H.264. Use H.265 if you need 10-bit HDR output.
                          </div>
                        )}
                      </div>
                    </div>
                    {videoCodec !== 'copy' && (
                      <div style={{ marginTop: '1rem' }}>
                        <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                            <input type="radio" name="qualityMode" checked={qualityMode === 'crf'} onChange={() => setQualityMode('crf')} />
                            <span style={{ fontSize: '0.875rem' }}>Constant Quality (CRF/CQ)</span>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                            <input type="radio" name="qualityMode" checked={qualityMode === 'bitrate'} onChange={() => setQualityMode('bitrate')} />
                            <span style={{ fontSize: '0.875rem' }}>Average Bitrate (kbps)</span>
                          </label>
                        </div>
                        
                        {qualityMode === 'crf' ? (
                          <>
                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Quality (Target Level: {crf})</label>
                            <input 
                              type="range" min="0" max="51" 
                              value={crf} 
                              onChange={(e) => setCrf(Number(e.target.value))}
                              style={{ width: '100%' }} 
                            />
                            <div style={{ textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Lower is better quality. (CRF/CQ Scale). Default: 22</div>
                          </>
                        ) : (
                          <>
                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Target Bitrate (kbps)</label>
                            <input 
                              type="number" 
                              className="input-field" 
                              value={videoBitrate} 
                              onChange={(e) => setVideoBitrate(e.target.value)}
                              placeholder="e.g. 5000"
                              style={{ width: '100%' }} 
                            />
                            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Video target bitrate in kbps.</div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
            );
            })()}

            {/* Subtitles Tab */}
            {activeTab === 'subtitles' && (
              <div className="tab-content" style={{ animation: 'fadeIn 0.3s ease', gridColumn: '1 / -1' }}>
                {subtitleConfigs.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                    No subtitle tracks found in the source file.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {subtitleConfigs.map((track, index) => (
                      <div key={index} className="track-card glass-panel" style={{ padding: '1.25rem', display: 'flex', alignItems: 'flex-start', gap: '1.5rem', borderLeft: track.action !== 'none' ? '4px solid #f1c40f' : '4px solid transparent' }}>
                        
                        {/* Track Info */}
                        <div style={{ flex: 2 }}>
                          <div style={{ fontWeight: 'bold', fontSize: '1.1rem', marginBottom: '0.25rem' }}>
                            Track #{track.input_index} ({track.language})
                          </div>
                          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            Format: {track.codec_name?.toUpperCase()}
                          </div>
                          <div style={{ marginTop: '0.75rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem' }}>Track Name</label>
                            <input 
                              type="text" 
                              className="input-field" 
                              value={track.title} 
                              onChange={(e) => {
                                const newConfigs = [...subtitleConfigs];
                                newConfigs[index].title = e.target.value;
                                setSubtitleConfigs(newConfigs);
                              }}
                              style={{ width: '100%' }}
                              disabled={track.action === 'none'}
                              placeholder="Subtitle Track Title..."
                            />
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem' }}>Action</label>
                          <select 
                            className="input-field" 
                            value={track.action} 
                            onChange={(e) => {
                              const newConfigs = [...subtitleConfigs];
                              newConfigs[index].action = e.target.value;
                              // If burn is selected, others can't be burned
                              if (e.target.value === 'burn') {
                                newConfigs.forEach((c, i) => { if (i !== index && c.action === 'burn') c.action = 'copy'; });
                              }
                              setSubtitleConfigs(newConfigs);
                            }}
                          >
                            <option value="none">Remove</option>
                            <option value="copy">Keep (Softsub)</option>
                            <option value="burn">Burn Into Video (Hardsub)</option>
                          </select>
                          {track.action === 'burn' && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--accent-color)', marginTop: '0.25rem' }}>
                              Warning: Burning subtitles forces video re-encoding and disables hardware scaling filters. Only 1 track can be burned.
                            </div>
                          )}
                        </div>

                        {/* Flags */}
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem' }}>Default Flag</label>
                          <select 
                            className="input-field" 
                            value={track.is_default ? "yes" : "no"} 
                            disabled={track.action === 'none' || track.action === 'burn'}
                            onChange={(e) => {
                              const newConfigs = [...subtitleConfigs];
                              newConfigs[index].is_default = e.target.value === "yes";
                              if (e.target.value === "yes") {
                                newConfigs.forEach((c, i) => { if (i !== index) c.is_default = false; });
                              }
                              setSubtitleConfigs(newConfigs);
                            }}
                          >
                            <option value="no">No</option>
                            <option value="yes">Yes</option>
                          </select>

                          <label style={{ display: 'block', marginTop: '0.5rem', marginBottom: '0.25rem', fontSize: '0.85rem' }}>Forced Flag</label>
                          <select 
                            className="input-field" 
                            value={track.is_forced ? "yes" : "no"} 
                            disabled={track.action === 'none' || track.action === 'burn'}
                            onChange={(e) => {
                              const newConfigs = [...subtitleConfigs];
                              newConfigs[index].is_forced = e.target.value === "yes";
                              setSubtitleConfigs(newConfigs);
                            }}
                          >
                            <option value="no">No</option>
                            <option value="yes">Yes</option>
                          </select>
                        </div>

                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Chapters & Metadata Tab */}
            {activeTab === 'metadata' && (
              <div className="tab-content" style={{ animation: 'fadeIn 0.3s ease', gridColumn: '1 / -1' }}>
                <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
                  <h3 style={{ margin: '0 0 1rem 0' }}>Global Options</h3>
                  
                  <div style={{ display: 'flex', gap: '2rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={keepChapters} 
                        onChange={(e) => setKeepChapters(e.target.checked)}
                        style={{ width: '1.25rem', height: '1.25rem' }}
                      />
                      <span>Include Chapters in Output</span>
                    </label>

                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={keepCoverArt} 
                        onChange={(e) => setKeepCoverArt(e.target.checked)}
                        style={{ width: '1.25rem', height: '1.25rem' }}
                      />
                      <span>Keep Attached Images (Cover Art)</span>
                    </label>
                  </div>
                  {!keepCoverArt && coverArtTracks.length > 0 && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                      {coverArtTracks.length} cover image(s) will be removed.
                    </div>
                  )}
                              </div>

                <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1.5rem', border: '1px dashed var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h3 style={{ margin: '0 0 0.25rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        🎬 Smart Scene Detection <span style={{ fontSize: '0.7rem', background: 'var(--accent-color)', padding: '0.1rem 0.4rem', borderRadius: '4px', color: 'white' }}>Beta</span>
                      </h3>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Use FFmpeg to scan the entire video for visual scene changes and intelligently place chapter marks.
                      </div>
                    </div>
                    <button className="btn btn-secondary" disabled style={{ opacity: 0.5, cursor: 'not-allowed', whiteSpace: 'nowrap' }}>
                      Run Scene Scan
                    </button>
                  </div>
                </div>

                <div className="glass-panel" style={{ padding: '1.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <h3 style={{ margin: 0 }}>Chapter Marks</h3>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <select 
                        className="input-field" 
                        value={autoChapterInterval} 
                        onChange={(e) => setAutoChapterInterval(Number(e.target.value))}
                        style={{ padding: '0.4rem', fontSize: '0.85rem' }}
                      >
                        <option value="120">2 mins</option>
                        <option value="180">3 mins</option>
                        <option value="300">5 mins</option>
                        <option value="600">10 mins</option>
                        <option value="900">15 mins</option>
                      </select>
                      <button 
                        className="btn btn-secondary" 
                        onClick={() => {
                          if (!mediaInfo?.format?.duration) return;
                          const dur = parseFloat(mediaInfo.format.duration);
                          const newChaps = [];
                          const interval = autoChapterInterval;
                          let i = 1;
                          for (let t = 0; t < dur; t += interval) {
                            newChaps.push({
                              id: i,
                              start_time: t,
                              end_time: Math.min(t + interval, dur),
                              title: `Chapter ${i}`
                            });
                            i++;
                          }
                          setChapters(newChaps);
                          setKeepChapters(true);
                        }}
                        style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}
                      >
                        ✨ Auto-Generate
                      </button>
                    </div>
                  </div>

                  {chapters.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                      No chapters found. Click Auto-Generate to create them.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', opacity: keepChapters ? 1 : 0.5, pointerEvents: keepChapters ? 'auto' : 'none' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '100px 100px 1fr', gap: '1rem', padding: '0 0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 'bold' }}>
                        <div>Start</div>
                        <div>End</div>
                        <div>Title</div>
                      </div>
                      {chapters.map((chap, idx) => {
                        const fmtTime = (s: number) => {
                          const h = Math.floor(s / 3600);
                          const m = Math.floor((s % 3600) / 60);
                          const sec = Math.floor(s % 60);
                          return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
                        };
                        return (
                          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '100px 100px 1fr', gap: '1rem', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '4px' }}>
                            <div style={{ fontFamily: 'monospace' }}>{fmtTime(chap.start_time)}</div>
                            <div style={{ fontFamily: 'monospace' }}>{fmtTime(chap.end_time)}</div>
                            <input 
                              type="text" 
                              className="input-field" 
                              value={chap.title} 
                              onChange={(e) => {
                                const newChaps = [...chapters];
                                newChaps[idx].title = e.target.value;
                                setChapters(newChaps);
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Trim Tab */}
            {activeTab === 'trim' && (
              <div className="tab-content" style={{ animation: 'fadeIn 0.3s ease', gridColumn: '1 / -1' }}>
                <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
                  <h3 style={{ margin: '0 0 1rem 0' }}>✂️ Trim / Select Region</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    
                    {/* Playhead Slider */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                      <span style={{ fontSize: '0.9rem', width: '60px' }}>{formatTime(playhead)}</span>
                      <input 
                        type="range" 
                        min="0" 
                        max={mediaInfo?.format?.duration ? parseFloat(mediaInfo.format.duration) : 100}
                        step="1"
                        value={playhead}
                        onChange={(e) => setPlayhead(Number(e.target.value))}
                        style={{ flex: 1, accentColor: 'var(--accent-color)' }}
                      />
                      <span style={{ fontSize: '0.9rem', width: '60px', textAlign: 'right' }}>
                        {mediaInfo?.format?.duration ? formatTime(parseFloat(mediaInfo.format.duration)) : "00:00:00"}
                      </span>
                    </div>

                    {/* Inputs & Buttons */}
                    <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-end' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Start Time (HH:MM:SS)</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <input 
                            type="text" 
                            className="input-field" 
                            placeholder="00:00:00"
                            value={trimStart}
                            onChange={(e) => setTrimStart(e.target.value)}
                            style={{ flex: 1 }}
                          />
                          <button 
                            className="btn btn-secondary" 
                            onClick={() => setTrimStart(formatTime(playhead))}
                          >
                            Set 👈
                          </button>
                        </div>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>End Time (HH:MM:SS)</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <input 
                            type="text" 
                            className="input-field" 
                            placeholder="00:00:00"
                            value={trimEnd}
                            onChange={(e) => setTrimEnd(e.target.value)}
                            style={{ flex: 1 }}
                          />
                          <button 
                            className="btn btn-secondary" 
                            onClick={() => setTrimEnd(formatTime(playhead))}
                          >
                            Set 👉
                          </button>
                        </div>
                      </div>
                      
                      <button 
                        className="btn btn-secondary" 
                        onClick={() => { setTrimStart(""); setTrimEnd(""); }}
                        title="Clear Trim Region"
                      >
                        ❌ Clear
                      </button>
                    </div>

                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Job Queue & Output Location */}
        <section className="job-queue glass-panel">
          {filePath && (
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', fontWeight: 'bold' }}>Target Location (Editable)</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input 
                  type="text" 
                  className="input-field" 
                  value={outputPath} 
                  onChange={(e) => setOutputPath(e.target.value)}
                  style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.85rem' }}
                />
                <button className="btn btn-secondary" onClick={handleBrowseOutput}>Browse</button>
                <button className="btn btn-secondary" onClick={handleOpenFolder} title="Open Output Folder">📂</button>
              </div>
            </div>
          )}
          <h4 style={{ margin: 0, marginBottom: '0.5rem' }}>Job Progress</h4>
          <div style={{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: jobStatus.includes('Error') || jobStatus.includes('Failed') ? 'var(--danger-color)' : jobStatus.includes('success') ? 'var(--success-color)' : 'var(--text-primary)', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '1rem', fontFamily: 'monospace' }}>
            {jobStatus}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
