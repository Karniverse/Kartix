import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

function App() {
  const [activeTab, setActiveTab] = useState("audio");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [mediaInfo, setMediaInfo] = useState<any>(null);
  const [encoders, setEncoders] = useState<string[]>([]);
  const [jobStatus, setJobStatus] = useState<string>("No active jobs.");
  const [outputPath, setOutputPath] = useState<string>("");
  
  // Settings State
  const [videoCodec, setVideoCodec] = useState("libx264");
  const [crf, setCrf] = useState(22);
  const [audioConfigs, setAudioConfigs] = useState<any[]>([]);

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

  useEffect(() => {
    invoke<string[]>("get_encoders").then(encs => {
      setEncoders(encs);
      if (encs.some(e => e.includes("NVENC"))) setVideoCodec("h264_nvenc");
      else if (encs.some(e => e.includes("QSV"))) setVideoCodec("h264_qsv");
      else if (encs.some(e => e.includes("AMF"))) setVideoCodec("h264_amf");
    }).catch(console.error);

    const unlistenSuccess = listen("job-success", (event) => {
      setJobStatus(`Job Completed successfully! Saved to: ${event.payload}`);
    });
    
    const unlistenError = listen("job-error", (event) => {
      setJobStatus(`Job Failed: ${event.payload}`);
    });

    const unlistenProgress = listen("job-progress", (event) => {
      // Very basic progress parsing (ffmpeg raw output)
      const line = event.payload as string;
      if (line.includes("time=")) {
        const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}.\d{2})/);
        if (timeMatch) {
          setJobStatus(`Processing... Time: ${timeMatch[1]}`);
        }
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
                source_bitrate: s.bit_rate,
                source_sample_rate: s.sample_rate
              };
            });
          setAudioConfigs(aConfigs);
        }
      }
    } catch (err) {
      console.error(err);
      setJobStatus(`Error: ${err}`);
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
        }))
      };

      await invoke("start_job", { request });
    } catch (err) {
      console.error(err);
      setJobStatus(`Failed to start job: ${err}`);
    }
  };

  const handleBrowseOutput = async () => {
    const outPath = await save({
      filters: [{ name: 'Video', extensions: ['mp4', 'mkv'] }]
    });
    if (outPath) setOutputPath(outPath);
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

        <div style={{ marginTop: 'auto' }}>
          <button className="btn btn-primary" onClick={handleStart} disabled={!filePath} style={{ width: '100%', padding: '0.75rem', opacity: filePath ? 1 : 0.5 }}>
            🚀 Start Conversion
          </button>
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
            </div>
          )}
        </header>

        {/* Media Settings Viewer */}
        <section className="media-viewer glass-panel">
          <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', marginBottom: '1rem', display: 'flex', gap: '1rem' }}>
            <button 
              className={`btn ${activeTab === 'video' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('video')}
            >
              Video
            </button>
            <button 
              className={`btn ${activeTab === 'audio' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('audio')}
            >
              Audio (Advanced)
            </button>
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
                    {track.source_bitrate && (
                      <span style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                        {Math.round(track.source_bitrate / 1000)}kbps
                      </span>
                    )}
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
              
              return (
                <>
                  {videoStream && (
                    <div className="settings-card" style={{ marginBottom: '1rem', background: 'rgba(255,255,255,0.05)' }}>
                      <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Source Video Details</h4>
                      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                        <span style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>
                          CODEC: {videoStream.codec_name?.toUpperCase()}
                        </span>
                        <span style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                          RES: {videoStream.width}x{videoStream.height}
                        </span>
                        {videoStream.bit_rate && (
                          <span style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                            BITRATE: {Math.round(videoStream.bit_rate / 1000)} kbps
                          </span>
                        )}
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

                  <div className="settings-card">
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
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }} title="Fixes H.264 10-bit encoder crashes by explicitly converting to 8-bit SDR.">Pixel Format</label>
                        <select className="input-field" value={pixelFormat} onChange={(e) => setPixelFormat(e.target.value)} disabled={videoCodec === 'copy'}>
                          <option value="auto">Auto (Copy Source)</option>
                          <option value="yuv420p">8-bit (SDR / H.264 Compatible)</option>
                          <option value="yuv420p10le">10-bit (HDR / HEVC Recommended)</option>
                        </select>
                      </div>
                    </div>
                    {videoCodec !== 'copy' && (
                      <div style={{ marginTop: '1rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Quality (Target Level: {crf})</label>
                        <input 
                          type="range" min="0" max="51" 
                          value={crf} 
                          onChange={(e) => setCrf(Number(e.target.value))}
                          style={{ width: '100%' }} 
                        />
                        <div style={{ textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Lower is better quality. (CRF/CQ Scale). Default: 22</div>
                      </div>
                    )}
                  </div>
                </>
            );
            })()}
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
