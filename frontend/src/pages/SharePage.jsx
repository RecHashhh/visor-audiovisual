// src/pages/SharePage.jsx — acceso externo sin login
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../utils/api'

export default function SharePage() {
  const { token } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lightbox, setLightbox] = useState(null)

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(r => { if (!r.ok) throw new Error('Enlace inválido o expirado'); return r.json() })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16 }}>
      <div className="spinner" style={{ width:36, height:36 }} />
      <span style={{ color:'var(--text-dim)', fontSize:'0.85rem' }}>Verificando enlace...</span>
    </div>
  )

  if (error) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:40, textAlign:'center', maxWidth:380 }}>
        <div style={{ fontSize:'2.5rem', marginBottom:16 }}>⏰</div>
        <h2 style={{ fontFamily:'var(--font-display)', marginBottom:8 }}>Enlace no disponible</h2>
        <p style={{ color:'var(--text-dim)', fontSize:'0.85rem' }}>{error}</p>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', padding:'24px 20px', maxWidth:1200, margin:'0 auto' }}>
      <div style={{ marginBottom:24 }}>
        <div style={{ fontFamily:'var(--font-display)', fontWeight:800, fontSize:'1.4rem', color:'var(--accent)' }}>VISOR AUDIOVISUAL</div>
        <div style={{ fontSize:'0.75rem', color:'var(--text-dim)', marginTop:4 }}>
          Acceso compartido · Proyecto {data?.projectId} · Semana {data?.week} ·{' '}
          <span style={{ color:'var(--orange)' }}>Expira: {new Date(data?.expiresAt).toLocaleDateString('es-EC')}</span>
        </div>
      </div>

      <h1 style={{ fontFamily:'var(--font-display)', fontSize:'1.1rem', marginBottom:16, color:'var(--text)' }}>
        {data?.projectName || data?.projectId} / {data?.week}
      </h1>

      <div className="gallery-grid">
        {(data?.files || []).map((file, i) => (
          <div key={file.name} className="gallery-item" onClick={() => setLightbox({ url: file.sasUrl, name: file.name, idx: i })}>
            {file.type === 'img' ? (
              <img src={file.sasUrl} alt={file.name} loading="lazy" />
            ) : (
              <div className="file-icon">
                <div className="file-icon-sym">{file.type === 'vid' ? '▶' : '📄'}</div>
                <div className="file-icon-name">{file.name}</div>
              </div>
            )}
            <div className="gallery-item-label">{file.name}</div>
          </div>
        ))}
      </div>

      {lightbox && (
        <div className="lightbox-overlay" onClick={e => e.target === e.currentTarget && setLightbox(null)}>
          <button className="lightbox-close" onClick={() => setLightbox(null)}>✕</button>
          {lightbox.url && <img className="lightbox-img" src={lightbox.url} alt={lightbox.name} />}
          <div className="lightbox-toolbar">
            <span className="lightbox-name">{lightbox.name}</span>
            <a className="btn btn-primary btn-sm" href={lightbox.url} download={lightbox.name} target="_blank" rel="noopener noreferrer">
              ⬇ Descargar
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
