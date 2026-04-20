import React, { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../utils/api'

// Helper de tipos (usando tu lógica original)
const prefixOf = (name) => {
  const p = name.split('_')[0]
  return ["DRN", "FOT", "VID", "E360", "I360"].includes(p.toUpperCase()) ? p.toUpperCase() : "FILE"
}

const PREFIX_BADGE = {
  DRN: 'badge-orange', FOT: 'badge-blue', VID: 'badge-red',
  E360: 'badge-accent', I360: 'badge-dim',
}

export default function GalleryPage() {
  const { id, week } = useParams()
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [lightbox, setLightbox] = useState(null)
  const [sasUrls, setSasUrls] = useState({})

  // 1. LÓGICA DE FILTRADO (Corrigiendo el error de inicialización)
  const prefixes = useMemo(() => {
    return [...new Set(files.map(f => prefixOf(f.name)))].filter(Boolean)
  }, [files])

  const displayFiles = useMemo(() => {
    return filter === 'all' ? files : files.filter(f => prefixOf(f.name) === filter)
  }, [files, filter])

  // 2. CARGA DE DATOS
  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.getFiles(id, week)
        setFiles(data)
        const paths = data.map(f => f.path)
        if (paths.length > 0) {
          const { urls } = await api.getSasBatch(paths, 120)
          setSasUrls(urls)
        }
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, week])

  // 3. MANEJO DE TECLADO
  useEffect(() => {
    const handler = (e) => {
      if (!lightbox) return
      if (e.key === 'ArrowRight') navLightbox(1)
      if (e.key === 'ArrowLeft') navLightbox(-1)
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightbox, displayFiles])

  const navLightbox = (dir) => {
    if (!displayFiles.length) return
    const idx = displayFiles.findIndex(f => f.path === lightbox.path)
    const next = displayFiles[(idx + dir + displayFiles.length) % displayFiles.length]
    setLightbox(next)
  }

  if (loading) return <div className="loading"><span>Cargando galería...</span></div>

  return (
    <div className="gallery-container">
      {/* Header & Filtros */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: '10px' }}>
          <Link to="/">Proyectos</Link> / {id} / {week}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <h2 className="title">Registro Audiovisual</h2>
          
          <div className="stats-bar" style={{ margin: 0 }}>
            <button 
              onClick={() => setFilter('all')}
              className={`badge ${filter === 'all' ? 'badge-blue' : 'badge-dim'}`}
              style={{ cursor: 'pointer', border: 'none' }}
            >
              Todos
            </button>
            {prefixes.map(p => (
              <button
                key={p}
                onClick={() => setFilter(p)}
                className={`badge ${filter === p ? (PREFIX_BADGE[p] || 'badge-blue') : 'badge-dim'}`}
                style={{ cursor: 'pointer', border: 'none' }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Grid de Archivos */}
      <div className="gallery-grid">
        {displayFiles.map((file) => (
          <div 
            key={file.path}
            className="gallery-item"
            onClick={() => setLightbox(file)}
          >
            <div className="file-icon">
              {file.type === 'img' && sasUrls[file.path] ? (
                <img src={sasUrls[file.path]} alt={file.name} style={{ width: '100%', height: '100%', objectCover: 'cover' }} />
              ) : (
                <div className="file-icon-sym">{file.type === 'vid' ? '▶' : '📄'}</div>
              )}
            </div>
            <div className="file-icon-name" style={{ padding: '8px', fontSize: '0.7rem' }}>
              {file.name}
            </div>
          </div>
        ))}
      </div>

      {/* Lightbox simplificado (Sin Lucide) */}
      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <button className="lightbox-close" onClick={() => setLightbox(null)}>✕</button>
          
          <div className="lightbox-content" onClick={e => e.stopPropagation()} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <button className="nav-btn left" onClick={() => navLightbox(-1)} style={{ background: 'none', border: 'none', color: 'white', fontSize: '2rem', padding: '20px', cursor: 'pointer' }}>‹</button>
            
            <div style={{ textAlign: 'center' }}>
              {lightbox.type === 'img' ? (
                <img src={sasUrls[lightbox.path]} alt="" style={{ maxWidth: '80vw', maxHeight: '80vh' }} />
              ) : lightbox.type === 'vid' ? (
                <video src={sasUrls[lightbox.path]} controls autoPlay style={{ maxWidth: '80vw', maxHeight: '80vh' }} />
              ) : (
                <div style={{ padding: '40px', background: '#111', borderRadius: '10px' }}>
                  <p>Vista previa no disponible</p>
                  <a href={sasUrls[lightbox.path]} download className="badge badge-blue" style={{ marginTop: '20px', display: 'inline-block', textDecoration: 'none' }}>Descargar</a>
                </div>
              )}
              <div style={{ marginTop: '10px', color: 'white', fontSize: '0.9rem' }}>{lightbox.name}</div>
            </div>

            <button className="nav-btn right" onClick={() => navLightbox(1)} style={{ background: 'none', border: 'none', color: 'white', fontSize: '2rem', padding: '20px', cursor: 'pointer' }}>›</button>
          </div>
        </div>
      )}
    </div>
  )
}
