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
  
  // Settings State
  const [videoCodec, setVideoCodec] = useState("libx264");
  const [crf, setCrf] = useState(22);
  const [audioConfigs, setAudioConfigs] = useState<any[]>([]);

  useEffect(() => {
    invoke<string[]>("get_encoders").then(setEncoders).catch(console.error);

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
        
        // Initialize audio configs based on streams
        if (info && (info as any).streams) {
          const aConfigs = ((info as any).streams as any[])
            .filter((s: any) => s.codec_type === 'audio')
            .map((s: any) => ({
              input_index: s.index,
              action: s.channels === 6 ? "discrete_51" : "copy",
              codec: "aac",
              normalize: false,
              _channels: s.channels,
              _title: s.tags?.title || s.tags?.language || `Track ${s.index}`
            }));
          setAudioConfigs(aConfigs);
        }
      }
    } catch (err) {
      console.error(err);
      setJobStatus(`Error: ${err}`);
    }
  };

  const handleStart = async () => {
    if (!filePath || !mediaInfo) return;
    
    try {
      const outPath = await save({
        filters: [{
          name: 'Video',
          extensions: ['mp4', 'mkv']
        }]
      });
      
      if (!outPath) return;

      setJobStatus("Starting job...");
      
      const request = {
        input_path: filePath,
        output_path: outPath,
        video_codec: videoCodec,
        crf: Number(crf),
        audio_tracks: audioConfigs.map(c => ({
          input_index: c.input_index,
          action: c.action,
          codec: c.codec,
          normalize: c.normalize
        }))
      };

      await invoke("start_job", { request });
    } catch (err) {
      console.error(err);
      setJobStatus(`Failed to start job: ${err}`);
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
                <h4>Track {track.input_index}: {track._title} ({track._channels === 6 ? '5.1' : track._channels === 2 ? '2.0' : track._channels + ' ch'})</h4>
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
                      <option value="upmix_dpl2">Software Upmix (ProLogic II 5.1)</option>
                      <option value="convert">Convert (Standard)</option>
                    </select>
                  </div>
                  {track.action !== 'copy' && (
                    <div>
                      <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Codec</label>
                      <select 
                        className="input-field"
                        value={track.codec}
                        onChange={(e) => updateAudioConfig(idx, 'codec', e.target.value)}
                      >
                        <option value="aac">AAC</option>
                        <option value="ac3">AC3</option>
                        <option value="eac3">E-AC3</option>
                        <option value="libopus">Opus</option>
                      </select>
                    </div>
                  )}
                  {track.action !== 'copy' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={track.normalize}
                        onChange={(e) => updateAudioConfig(idx, 'normalize', e.target.checked)}
                      />
                      <span style={{ fontSize: '0.875rem' }}>EBU R128 Normalization</span>
                    </label>
                  )}
                </div>
              </div>
            ))}
            {activeTab === 'audio' && audioConfigs.length === 0 && (
              <div style={{ color: 'var(--text-secondary)' }}>No audio tracks found or file not loaded.</div>
            )}

            {activeTab === 'video' && (
              <div className="settings-card">
                <h4>Video Encoding</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
                    <div>
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
                    {videoCodec !== 'copy' && (
                      <div>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>Quality (CRF: {crf})</label>
                        <input 
                          type="range" min="0" max="51" 
                          value={crf} 
                          onChange={(e) => setCrf(Number(e.target.value))}
                          style={{ width: '100%' }} 
                        />
                        <div style={{ textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Lower is better quality. Default: 22</div>
                      </div>
                    )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Job Queue */}
        <section className="job-queue glass-panel">
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
