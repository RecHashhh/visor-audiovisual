// src/pages/GalleryPage.jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../utils/api'
import { fetchThumb } from '../utils/thumbs'
import { useFavorites } from '../utils/favorites'
import { useDownloads } from '../utils/downloads'
import Modal from '../components/Modal'
import SmartVideo from '../components/SmartVideo'
import { useAuthz } from '../utils/authz'
import { DeleteProjectDialog } from '../components/ProjectTools'
import { TagChips, TagDialog } from '../components/MediaTags'
import { weekLabel } from '../utils/weekLabel'

// Corazón (relleno = ya es favorito)
function HeartIcon({ filled }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  )
}

const PREFIX_BADGE = {
  DRN: 'badge-orange', FOT: 'badge-blue', VID: 'badge-red',
  E360: 'badge-accent', I360: 'badge-dim',
}
const IMG_EXTS  = ['jpg','jpeg','png','tiff','tif','webp','gif']
const VID_EXTS  = ['mp4','mov','avi']
const RAW_EXTS  = ['dng','cr3','arw','raw','nef']
const I360_EXTS = ['insv']

function extOf(name) { return name.split('.').pop().toLowerCase() }
function prefixOf(name) { return name.split('_')[0].toUpperCase() }
function isImg(name)  { return IMG_EXTS.includes(extOf(name)) }
function isVid(name)  { return VID_EXTS.includes(extOf(name)) }
function isRaw(name)  { return RAW_EXTS.includes(extOf(name)) }
function isI360(name) { return I360_EXTS.includes(extOf(name)) }
function kindOf(name) {
  if (isImg(name)) return 'img'
  if (isVid(name)) return 'vid'
  if (isRaw(name)) return 'raw'
  if (isI360(name)) return 'i360'
  return 'file'
}
function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return 'No disponible'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
function formatDate(isoDate) {
  if (!isoDate) return 'No disponible'
  const dt = new Date(isoDate)
  if (Number.isNaN(dt.getTime())) return 'No disponible'
  return dt.toLocaleString('es-CL')
}
function orientationOf(width, height) {
  if (!width || !height) return 'No disponible'
  if (width === height) return 'Cuadrada'
  return width > height ? 'Horizontal' : 'Vertical'
}
function aspectRatioOf(width, height) {
  if (!width || !height) return 'No disponible'
  const ratio = (width / height).toFixed(2)
  return `${ratio}:1`
}

function sizeBucketOf(bytes) {
  const size = Number(bytes || 0)
  if (size < 1024 * 1024) return 'small' // < 1 MB
  if (size < 10 * 1024 * 1024) return 'medium' // 1 MB - 9.99 MB
  return 'large' // >= 10 MB
}

function readImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('No se pudo leer metadata de la imagen'))
    img.src = url
  })
}


export default function GalleryPage({ collection = null, onRemove, originLabel }) {
  const { id, week } = useParams()
  const { me } = useAuthz()
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [tagCatalog, setTagCatalog] = useState([])
  const [tagAssignments, setTagAssignments] = useState({})
  const [tagFilter, setTagFilter] = useState('')
  const [tagDialog, setTagDialog] = useState(null)
  const [tagBusy, setTagBusy] = useState(false)
  const [tagError, setTagError] = useState('')
  const [tagsReady, setTagsReady] = useState(false)
  async function reloadAfterDelete() {
    const tree = await api.getBrowse(id, week || '')
    setBrowse(tree)
    setViewer(null); setFullscreenViewer(null)
    exitSel()
  }
  const nav = useNavigate()
  const [browse, setBrowse] = useState({ folders: [], files: [] })
  const [sasCache, setSasCache] = useState({})
  const [thumbCache, setThumbCache] = useState({})
  const closeTimerRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [order, setOrder] = useState('date')
  const [lbxPanel, setLbxPanel] = useState(null)   // null | 'details' | 'tags' (fila extra bajo la barra del visor)
  const [sizeFilter, setSizeFilter] = useState('all')
  const [viewer, setViewer] = useState(null)  // { idx, url, file, kind, width, height, metaLoading }
  const [previewOpen, setPreviewOpen] = useState(false)
  const [fullscreenViewer, setFullscreenViewer] = useState(null)
  const [shareLink, setShareLink] = useState(null)
  const [sharingDays, setSharingDays] = useState(7)
  const [showSharePanel, setShowSharePanel] = useState(false)
  const [copied, setCopied] = useState(false)
  const viewerRequestIdRef = useRef(0)
  const lightboxRef = useRef(null)
  const weekLabel = (week || '').split('/').join(' / ')
  const lightboxOpen = Boolean(fullscreenViewer)

  const { isFav, collections, createCollection, addToCollection, removeFromAll } = useFavorites()
  const [favTarget, setFavTarget] = useState(null)   // archivo a agregar a una colección
  const [newColName, setNewColName] = useState('')
  const [favBusy, setFavBusy] = useState(false)

  const onHeart = useCallback((file) => {
    if (isFav(file.path)) { removeFromAll(file.path).catch(() => {}); return }
    setNewColName(''); setFavTarget(file)
  }, [isFav, removeFromAll])

  const addTargetTo = async (collectionId) => {
    if (!favTarget) return
    setFavBusy(true)
    try {
      await addToCollection(collectionId, {
        path: favTarget.path, name: favTarget.name,
        projectCode: id, projectName: id, week: week || '',
      })
      setFavTarget(null)
    } catch {} finally { setFavBusy(false) }
  }

  const createAndAdd = async () => {
    const name = newColName.trim()
    if (!name) return
    setFavBusy(true)
    try {
      const col = await createCollection(name)
      if (col) await addTargetTo(col.id)
    } catch {} finally { setFavBusy(false) }
  }

  // Accesibilidad del lightbox: foco inicial dentro, Tab no escapa,
  // y al cerrar el foco vuelve a donde estaba.
  useEffect(() => {
    if (!lightboxOpen || !lightboxRef.current) return
    const node = lightboxRef.current
    const previouslyFocused = document.activeElement
    const focusables = () => node.querySelectorAll('button, a[href], video')
    focusables()[0]?.focus()
    const onKey = (e) => {
      if (e.key !== 'Tab') return
      const els = Array.from(focusables())
      if (!els.length) return
      const first = els[0]
      const last = els[els.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    node.addEventListener('keydown', onKey)
    return () => {
      node.removeEventListener('keydown', onKey)
      previouslyFocused?.focus?.()
    }
  }, [lightboxOpen])

  useEffect(() => {
    setLoading(true)
    setBrowse({ folders: [], files: [] })
    setLoadError(null)
    setViewer(null)
    setPreviewOpen(false)
    setSelected(new Set()); setSelMode(false); setDeleteTarget(null)

    if (collection) {
      setBrowse({ folders: [], files: collection.items || [] })
      setLoading(false)
      return
    }
    api.getBrowse(id, week || '')
      .then(setBrowse)
      .catch(e => setLoadError(e.message))
      .finally(() => setLoading(false))
  }, [id, week, collection?.id])

  useEffect(() => {
    if (collection) setBrowse({ folders: [], files: collection.items || [] })
  }, [collection])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
      // Las miniaturas viven en la caché compartida (utils/thumbs): no se
      // revocan al salir, así volver a esta semana es instantáneo.
    }
  }, [])

  const getSas = useCallback(async (blobPath, minutes = 60) => {
    if (sasCache[blobPath]) return sasCache[blobPath]
    const res = await api.getSasUrl(blobPath, minutes)
    setSasCache(c => ({ ...c, [blobPath]: res.sasUrl }))
    return res.sasUrl
  }, [sasCache])

  const openViewer = async (file, idx) => {
    const requestId = viewerRequestIdRef.current + 1
    viewerRequestIdRef.current = requestId
    const kind = kindOf(file.name)
    const requiresUrl = kind === 'img' || kind === 'vid'
    if (!collection) setFullscreenViewer(null)
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setViewer({ idx, url: null, file, kind, width: null, height: null, metaLoading: requiresUrl, urlLoading: requiresUrl })
    setPreviewOpen(true)

    if (!requiresUrl) return

    let url = null
    try {
      // Video: copia liviana si existe. Va aparte de getSas para que Descargar
      // (que usa ese caché) siga entregando siempre el original.
      url = kind === 'vid' ? (await api.getPlaybackUrl(file.path)).sasUrl : await getSas(file.path)
      if (viewerRequestIdRef.current !== requestId) return
      setViewer((curr) => {
        if (!curr || curr.file?.path !== file.path) return curr
        return { ...curr, url, urlLoading: false }
      })
    } catch {
      if (viewerRequestIdRef.current !== requestId) return
      setViewer((curr) => {
        if (!curr || curr.file?.path !== file.path) return curr
        return { ...curr, urlLoading: false, metaLoading: false }
      })
      return
    }

    // En video la resolución la entrega el propio reproductor (onVideoMeta):
    // un segundo <video> oculto competiría por la red con el que se ve.
    if (kind === 'vid') return

    try {
      const meta = await readImageDimensions(url)
      setViewer((curr) => {
        if (!curr || curr.url !== url) return curr
        return { ...curr, ...meta, metaLoading: false }
      })
    } catch {
      setViewer((curr) => {
        if (!curr || curr.url !== url) return curr
        return { ...curr, metaLoading: false }
      })
    }
  }

  const onVideoMeta = (url, meta) => {
    setViewer((curr) => {
      if (!curr || curr.url !== url) return curr
      return { ...curr, ...meta, metaLoading: false }
    })
  }

  const openItem = async (file, idx) => {
    await openViewer(file, idx)
  }

  const navViewer = async (dir) => {
    const curIdx = displayFiles.findIndex(f => f.path === viewer?.file?.path)
    const next = displayFiles[(curIdx + dir + displayFiles.length) % displayFiles.length]
    if (!next) return
    const realIdx = displayFiles.indexOf(next)
    await openViewer(next, realIdx)
  }

  const closeViewer = () => {
    viewerRequestIdRef.current += 1
    setFullscreenViewer(null)
    setPreviewOpen(false)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (collection) { setViewer(null); return }
    closeTimerRef.current = setTimeout(() => {
      setViewer(null)
      closeTimerRef.current = null
    }, 180)
  }

  const { downloadSingle, downloadZip, isBusy } = useDownloads()
  // Formato original con bandeja de progreso; los videos grandes van directo a disco.
  const download = (file) => downloadSingle(({ download: attach }) => attach
    ? api.getSasUrl(file.path, 240, file.name).then(r => r.sasUrl)
    : getSas(file.path, 240), file.name, file.size)

  // Selección múltiple para descargar en ZIP
  const [selMode, setSelMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const toggleSel = (path) => setSelected(s => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n })
  const exitSel = () => { setSelMode(false); setSelected(new Set()) }

  const downloadSelected = async () => {
    if (isBusy()) return
    const chosen = displayFiles.filter(f => selected.has(f.path))
    if (!chosen.length) return
    const resolved = await Promise.all(chosen.map(async f => ({ name: f.name, url: await getSas(f.path, 120) })))
    const wk = (week || '').split('/').pop() || 'fotos'
    downloadZip(resolved, collection ? `${collection.name}.zip` : `${id}_${wk}.zip`)
    exitSel()
  }

  const generateShare = async () => {
    try {
      const res = await api.createShare(id, week, sharingDays)
      setShareLink(`${window.location.origin}/share/${res.token}`)
    } catch {}
  }

  const copyLink = () => {
    if (!shareLink) return
    navigator.clipboard.writeText(shareLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const files = browse.files || []
  useEffect(() => {
    let alive = true
    setTagAssignments({}); setTagFilter(''); setTagDialog(null); setTagError(''); setTagsReady(false)
    // Etiquetas: herramienta del Equipo TI; el resto ni las carga ni las ve.
    if (!files.length || !me?.caps?.tagMedia) return () => { alive = false }
    const load = async () => {
      const { catalog } = await api.getTags()
      const assignments = {}
      for (let i = 0; i < files.length; i += 3000) Object.assign(assignments, await api.lookupTags(files.slice(i, i + 3000).map(f => f.path)))
      if (alive) { setTagCatalog(catalog); setTagAssignments(assignments); setTagsReady(true) }
    }
    load().catch(e => { if (alive) setTagError(e.message) })
    return () => { alive = false }
  }, [browse.files])
  const applyTags = async (paths, add, remove) => {
    setTagBusy(true); setTagError('')
    try {
      for (let i = 0; i < paths.length; i += 2000) {
        const result = await api.applyTags(paths.slice(i, i + 2000), add, remove)
        setTagAssignments(prev => ({ ...prev, ...result }))
      }
      setTagDialog(null)
    } catch (e) { setTagError(e.message) } finally { setTagBusy(false) }
  }
  const fileTags = (file, dark = false) => <TagChips catalog={tagCatalog} ids={tagAssignments[file.path] || []} dark={dark}
    editable={!!me?.caps?.tagMedia && tagsReady} busy={tagBusy}
    onToggle={tag => applyTags([file.path], (tagAssignments[file.path] || []).includes(tag) ? [] : [tag], (tagAssignments[file.path] || []).includes(tag) ? [tag] : [])} />
  const folders = browse.folders || []
  const showFoldersOnly = folders.length > 0
  const prefixes = [...new Set(files.map(f => prefixOf(f.name)))].filter(Boolean)
  const orderedFiles = collection ? [...files].sort((a, b) => order === 'project'
    ? (a.projectCode || '').localeCompare(b.projectCode || '') || a.path.localeCompare(b.path)
    : (b.addedAt || '').localeCompare(a.addedAt || '')) : files
  const formatFilteredFiles = filter === 'all' ? orderedFiles : orderedFiles.filter(f => collection ? kindOf(f.name) === filter : prefixOf(f.name) === filter)
  const sizeFilteredFiles = sizeFilter === 'all'
    ? formatFilteredFiles
    : formatFilteredFiles.filter(f => sizeBucketOf(f.size) === sizeFilter)
  const displayFiles = tagFilter ? sizeFilteredFiles.filter(f => (tagAssignments[f.path] || []).includes(tagFilter)) : sizeFilteredFiles
  useEffect(() => {
    if (tagFilter && tagsReady && !files.some(f => (tagAssignments[f.path] || []).includes(tagFilter))) setTagFilter('')
  }, [tagAssignments, tagFilter, tagsReady, browse.files])

  const sizeCounts = {
    small: files.filter(f => sizeBucketOf(f.size) === 'small').length,
    medium: files.filter(f => sizeBucketOf(f.size) === 'medium').length,
    large: files.filter(f => sizeBucketOf(f.size) === 'large').length,
  }

  const counts = {
    img: files.filter(f => isImg(f.name)).length,
    vid: files.filter(f => isVid(f.name)).length,
    raw: files.filter(f => isRaw(f.name)).length,
  }

  // Keyboard nav for lightbox
  useEffect(() => {
    const handler = (e) => {
      if (!viewer) return
      if (e.key === 'ArrowRight') navViewer(1)
      if (e.key === 'ArrowLeft')  navViewer(-1)
      if (e.key === 'Escape')     closeViewer()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [viewer, displayFiles])

  useEffect(() => {
    const handler = (e) => {
      if (!fullscreenViewer) return
      if (e.key === 'Escape') setFullscreenViewer(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [fullscreenViewer])

  useEffect(() => {
    if (collection) setFullscreenViewer(viewer)
  }, [collection, viewer])

  const originUrl = (file) => `/proyectos/project/${encodeURIComponent(file.projectCode || file.path.split('/')[0])}/week/${encodeURIComponent(file.week || file.path.split('/').slice(1, -1).join('/'))}`

  return (
    <>
      {!collection && <>
      <div className="breadcrumb">
        <Link to="/proyectos">Proyectos</Link>
        <span className="sep">›</span>
        <Link to={`/proyectos/project/${id}`}>{id}</Link>
        <span className="sep">›</span>
        <span className="current">{weekLabel}</span>
      </div>

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 className="page-title project-code-title" style={{ fontSize: '1.2rem' }}>
            {id} <span>/ {weekLabel}</span>
          </h1>
          <p className="page-sub">
            {folders.length} carpetas · {files.length} archivos · {counts.img} imágenes · {counts.vid} videos · {counts.raw} RAW
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowSharePanel(s => !s)}>
          Compartir semana
        </button>
      </div>

      </>}
      {/* Share panel */}
      {showSharePanel && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px', marginBottom: '16px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: '10px', fontSize: '0.9rem' }}>
            Generar enlace externo (sin login)
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Expira en:</span>
            {[7, 14, 30].map(d => (
              <button key={d} className={`filter-chip ${sharingDays === d ? 'active' : ''}`}
                onClick={() => setSharingDays(d)}>{d} días</button>
            ))}
            <button className="btn btn-primary btn-sm" onClick={generateShare}>Generar link</button>
          </div>
          {shareLink && (
            <div style={{ marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', background: 'var(--bg3)', padding: '10px 12px', borderRadius: 'var(--radius)', flexWrap: 'wrap' }}>
              <code style={{ flex: 1, fontSize: '0.75rem', wordBreak: 'break-all' }}>{shareLink}</code>
              <button className="btn btn-primary btn-sm" onClick={copyLink}>
                {copied ? 'Copiado ✓' : 'Copiar'}
              </button>
            </div>
          )}
        </div>
      )}

      {loading && <div className="loading"><div className="spinner"/></div>}
      {!loading && loadError && (
        <div className="alert alert-error" role="alert">No se pudo cargar: {loadError}</div>
      )}

      {!loading && !loadError && (
        <div className={`gallery-split ${viewer && !collection ? 'has-preview' : 'no-preview'}`}>
          <div className="gallery-main">
            {folders.length > 0 && (
              <div className="week-list">
                {folders.map((folder) => (
                  <div
                    key={folder.path}
                    className="week-row"
                    onClick={() => nav(`/proyectos/project/${id}/week/${encodeURIComponent(folder.path)}`)}
                  >
                    <div className="week-label">{folder.name}</div>
                    <div className="week-badges">
                      {(folder.types || []).map((t) => (
                        <span key={t} className={`badge ${PREFIX_BADGE[t] || 'badge-dim'}`}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="week-count">{folder.count} archivos</div>
                    {me?.caps?.deleteMedia && /(?:^|\/)\d{4}_S\d{2}$/.test(folder.path) && (
                      <button className="btn btn-danger btn-sm" onClick={e => {
                        e.stopPropagation(); setDeleteTarget({ week: folder.path, count: folder.count })
                      }}>Eliminar semana</button>
                    )}
                    <div className="week-arrow">›</div>
                  </div>
                ))}
              </div>
            )}

            {!showFoldersOnly && (
              <>
                {/* Filters */}
                <div className="gallery-toolbar">
                  {!collection && tagCatalog.map(t => {
                    const count = files.filter(f => (tagAssignments[f.path] || []).includes(t.id)).length
                    return count > 0 && <button key={t.id} className={`tag-filter filter-chip ${tagFilter === t.id ? 'active' : ''}`}
                      aria-pressed={tagFilter === t.id} onClick={() => setTagFilter(tagFilter === t.id ? '' : t.id)}>{t.label} ({count})</button>
                  })}
                  <button className={`filter-chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
                    Todos ({files.length})
                  </button>
                  {(collection ? ['img', 'vid'] : prefixes).map(p => (
                    <button key={p} className={`filter-chip ${filter === p ? 'active' : ''}`} onClick={() => setFilter(p)}>
                      {collection ? (p === 'img' ? 'Fotos' : 'Videos') : p} ({files.filter(f => collection ? kindOf(f.name) === p : prefixOf(f.name) === p).length})
                    </button>
                  ))}
                </div>

                {collection && <select className="field-input" aria-label="Ordenar colección" value={order} onChange={e => setOrder(e.target.value)}>
                  <option value="date">Fecha agregada</option><option value="project">Proyecto</option>
                </select>}
                {!collection && <div className="gallery-toolbar" style={{ marginTop: 8 }}>
                  <button className={`filter-chip ${sizeFilter === 'all' ? 'active' : ''}`} onClick={() => setSizeFilter('all')}>
                    Cualquier tamaño ({files.length})
                  </button>
                  <button className={`filter-chip ${sizeFilter === 'small' ? 'active' : ''}`} onClick={() => setSizeFilter('small')}>
                    Pequeño ({sizeCounts.small})
                  </button>
                  <button className={`filter-chip ${sizeFilter === 'medium' ? 'active' : ''}`} onClick={() => setSizeFilter('medium')}>
                    Mediano ({sizeCounts.medium})
                  </button>
                  <button className={`filter-chip ${sizeFilter === 'large' ? 'active' : ''}`} onClick={() => setSizeFilter('large')}>
                    Grande ({sizeCounts.large})
                  </button>
                </div>}
                <div className="gallery-selbar">
                  {!selMode ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelMode(true)}>
                      ☑ {me?.caps?.deleteMedia && !collection ? 'Seleccionar' : 'Seleccionar para descargar'}
                    </button>
                  ) : (
                    <>
                      <span className="gallery-selbar-count">{selected.size} seleccionada{selected.size !== 1 ? 's' : ''}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set(displayFiles.map(f => f.path)))}>Todo ({displayFiles.length})</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Ninguno</button>
                      {!collection && me?.caps?.tagMedia && <button className="btn btn-ghost btn-sm" disabled={!selected.size || tagBusy || !tagsReady}
                        onClick={() => setTagDialog([...selected])}>Etiquetar ({selected.size})</button>}
                      <button className="btn btn-primary btn-sm" onClick={downloadSelected} disabled={!selected.size || isBusy()}>
                        Descargar ZIP ({selected.size})
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={exitSel}>Cancelar</button>
                      {me?.caps?.deleteMedia && !collection && <button className="btn btn-danger btn-sm" disabled={!selected.size}
                        onClick={() => setDeleteTarget({ paths: [...selected], count: selected.size })}>Eliminar ({selected.size})</button>}
                    </>
                  )}
                </div>

                <div className="gallery-grid">
                  {displayFiles.map((file, idx) => (
                    <GalleryItem
                      key={file.path || file.name}
                      file={file}
                      thumbUrl={thumbCache[file.path] || null}
                      onThumbLoaded={(url) => {
                        setThumbCache((c) => (c[file.path] ? c : { ...c, [file.path]: url }))
                      }}
                      getSas={getSas}
                      onClick={() => (selMode ? toggleSel(file.path) : openItem(file, idx))}
                      active={viewer?.file?.path === file.path}
                      label={collection ? originLabel?.(file) : null}
                      tags={tagCatalog.filter(t => (tagAssignments[file.path] || []).includes(t.id))}
                      fav={isFav(file.path)}
                      onFav={() => collection ? onRemove?.(file.path) : onHeart(file)}
                      selMode={selMode}
                      checked={selected.has(file.path)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {viewer && !collection && (
            <aside className={`gallery-preview ${previewOpen ? 'open' : 'closing'}`}>
              <div className="gallery-preview-header">
                <div className="gallery-preview-titleWrap">
                  <div className="gallery-preview-title">{viewer.file?.name || 'Sin nombre'}</div>
                  <div className="gallery-preview-subtitle">Vista previa dentro de la página</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={closeViewer}>Cerrar</button>
              </div>

              <div className="gallery-preview-media" onClick={() => viewer.kind === 'img' && setFullscreenViewer(viewer)}>
                {viewer.urlLoading && (
                  <div className="gallery-preview-empty">
                    <div className="spinner" />
                    <div className="gallery-preview-emptyTitle">Preparando vista previa</div>
                    <div className="gallery-preview-emptyText">El panel ya está abierto; cargando el archivo...</div>
                  </div>
                )}

                {!viewer.urlLoading && viewer.kind === 'img' && viewer.url && (
                  <img className="gallery-preview-img" src={viewer.url} alt={viewer.file?.name || 'preview'} />
                )}

                {!viewer.urlLoading && viewer.kind === 'vid' && viewer.url && !viewer.unsupported && (
                  <SmartVideo
                    src={viewer.url}
                    className="gallery-preview-video"
                    onLoadedMetadata={e => onVideoMeta(viewer.url, { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
                    onUnsupported={() => onVideoMeta(viewer.url, { unsupported: true })}
                  />
                )}

                {!viewer.urlLoading && viewer.kind === 'vid' && viewer.unsupported && (
                  <div className="gallery-preview-empty">
                    <div className="gallery-preview-emptyTitle">Este video no se puede reproducir en el navegador</div>
                    <div className="gallery-preview-emptyText">Su formato (por ejemplo ProRes o HEVC) no es compatible. Descárgalo para verlo.</div>
                  </div>
                )}

                {!viewer.urlLoading && (viewer.kind === 'img' || viewer.kind === 'vid') && !viewer.url && (
                  <div className="gallery-preview-empty">
                    <div className="gallery-preview-emptyTitle">No se pudo cargar la vista previa</div>
                    <div className="gallery-preview-emptyText">Puedes descargar el archivo para abrirlo localmente.</div>
                    <button className="btn btn-primary btn-sm" onClick={() => download(viewer.file)}>Descargar archivo</button>
                  </div>
                )}

                {!viewer.urlLoading && !viewer.url && (viewer.kind === 'raw' || viewer.kind === 'i360' || viewer.kind === 'file') && (
                  <div className="lightbox-file-fallback">
                    <div className="lightbox-file-icon">{viewer.kind === 'raw' ? 'RAW' : viewer.kind === 'i360' ? '360°' : '📄'}</div>
                    <div className="lightbox-file-text">Vista previa no disponible</div>
                    <button className="btn btn-primary btn-sm" onClick={() => download(viewer.file)}>Descargar archivo</button>
                  </div>
                )}
              </div>

              <div className="gallery-preview-content">
                {viewer.file && fileTags(viewer.file)}
                <div className="gallery-preview-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => navViewer(-1)}>‹ Anterior</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => navViewer(1)}>Siguiente ›</button>
                  <button className="btn btn-primary btn-sm" onClick={() => download(viewer.file)}>Descargar</button>
                </div>

                <div className="lightbox-meta-panel gallery-preview-meta">
                  {viewer.file?.size != null && <div className="meta-row"><span>Tamaño:</span><strong>{formatBytes(viewer.file?.size)}</strong></div>}
                  <div className="meta-row">
                    <span>Resolución:</span>
                    <strong>
                      {viewer.urlLoading
                        ? 'Preparando...'
                        : viewer.metaLoading
                        ? 'Calculando...'
                        : (viewer.width && viewer.height ? `${viewer.width} x ${viewer.height} px` : 'No disponible')}
                    </strong>
                  </div>
                  <div className="meta-row"><span>Orientación:</span><strong>{orientationOf(viewer.width, viewer.height)}</strong></div>
                  <div className="meta-row"><span>Proporción:</span><strong>{aspectRatioOf(viewer.width, viewer.height)}</strong></div>
                  <div className="meta-row"><span>Tipo:</span><strong>{extOf(viewer.file?.name || '').toUpperCase() || 'N/A'}</strong></div>
                  {viewer.file?.lastModified && <div className="meta-row"><span>Modificado:</span><strong>{formatDate(viewer.file?.lastModified)}</strong></div>}
                </div>
              </div>
            </aside>
          )}

          {fullscreenViewer && createPortal(
            <div
              ref={lightboxRef}
              className="lightbox-overlay"
              role="dialog"
              aria-modal="true"
              aria-label={`Vista completa: ${fullscreenViewer.file?.name || 'archivo'}`}
              onClick={e => e.target === e.currentTarget && (collection ? closeViewer() : setFullscreenViewer(null))}
            >
              <button className="lightbox-close" aria-label="Cerrar vista completa" onClick={() => collection ? closeViewer() : setFullscreenViewer(null)}>✕</button>
              <button className="lightbox-nav prev" onClick={() => navViewer(-1)}>‹</button>
              <button className="lightbox-nav next" onClick={() => navViewer(1)}>›</button>

              <div className="lbx-stage" onClick={e => e.target === e.currentTarget && (collection ? closeViewer() : setFullscreenViewer(null))}>
              {fullscreenViewer.urlLoading ? <div className="spinner" /> : fullscreenViewer.kind === 'vid' ? (
                <SmartVideo key={fullscreenViewer.file.path} className="lightbox-img" src={fullscreenViewer.url}
                  onLoadedMetadata={e => onVideoMeta(fullscreenViewer.url, { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
                  onUnsupported={() => onVideoMeta(fullscreenViewer.url, { unsupported: true })} />
              ) : fullscreenViewer.kind === 'img' && fullscreenViewer.url ? (
                <img className="lightbox-img" src={fullscreenViewer.url} alt={fullscreenViewer.file?.name || 'preview'} />
              ) : <div className="lightbox-file-fallback">Vista previa no disponible</div>}
              {fullscreenViewer.unsupported && <span className="lbx-note">Descarga el video para reproducirlo.</span>}
              </div>

              <div className="lbx-dock">
                <div className="lbx-row">
                  <div className="lbx-info">
                    <span className="lbx-name" title={fullscreenViewer.file?.name}>{fullscreenViewer.file?.name || 'Sin nombre'}</span>
                    <span className="lbx-origin">{collection ? originLabel?.(fullscreenViewer.file) : weekLabel(week || '')}</span>
                  </div>
                  <div className="lbx-actions">
                    <button type="button" className={`btn btn-ghost btn-sm ${lbxPanel === 'details' ? 'is-on' : ''}`} aria-expanded={lbxPanel === 'details'}
                      onClick={() => setLbxPanel(p => (p === 'details' ? null : 'details'))}>Detalles</button>
                    {fullscreenViewer.file && me?.caps?.tagMedia && tagCatalog.length > 0 && (
                      <button type="button" className={`btn btn-ghost btn-sm ${lbxPanel === 'tags' ? 'is-on' : ''}`} aria-expanded={lbxPanel === 'tags'}
                        onClick={() => setLbxPanel(p => (p === 'tags' ? null : 'tags'))}>
                        Etiquetas{(tagAssignments[fullscreenViewer.file.path] || []).length ? ` (${(tagAssignments[fullscreenViewer.file.path] || []).length})` : ''}
                      </button>
                    )}
                    {collection && <Link className="btn btn-ghost btn-sm" to={originUrl(fullscreenViewer.file)}>Ir al origen</Link>}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => download(fullscreenViewer.file)}>Descargar</button>
                  </div>
                </div>
                {lbxPanel === 'tags' && fullscreenViewer.file && me?.caps?.tagMedia && (
                  <div className="lbx-panel">{fileTags(fullscreenViewer.file, true)}</div>
                )}
                {lbxPanel === 'details' && (
                  <dl className="lbx-panel lbx-details">
                    {fullscreenViewer.file?.size != null && <><dt>Tamaño</dt><dd>{formatBytes(fullscreenViewer.file.size)}</dd></>}
                    <dt>Resolución</dt><dd>{fullscreenViewer.metaLoading ? 'Calculando…' : (fullscreenViewer.width && fullscreenViewer.height ? `${fullscreenViewer.width} × ${fullscreenViewer.height} px` : '—')}</dd>
                    {fullscreenViewer.width && fullscreenViewer.height && <><dt>Orientación</dt><dd>{orientationOf(fullscreenViewer.width, fullscreenViewer.height)}</dd>
                      <dt>Proporción</dt><dd>{aspectRatioOf(fullscreenViewer.width, fullscreenViewer.height)}</dd></>}
                    <dt>Tipo</dt><dd>{extOf(fullscreenViewer.file?.name || '').toUpperCase() || '—'}</dd>
                    {fullscreenViewer.file?.lastModified && <><dt>Modificado</dt><dd>{formatDate(fullscreenViewer.file.lastModified)}</dd></>}
                  </dl>
                )}
              </div>
            </div>,
            document.body
          )}
        </div>
      )}

      {deleteTarget && <DeleteProjectDialog projectId={id} target={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={reloadAfterDelete} />}
      {tagError && <div className="tag-error field-error" role="alert">{tagError}</div>}
      {tagDialog && <TagDialog paths={tagDialog} catalog={tagCatalog} assignments={tagAssignments} busy={tagBusy} error={tagError}
        onClose={() => setTagDialog(null)} onApply={(add, remove) => applyTags(tagDialog, add, remove)} />}
      <Modal
        open={!!favTarget}
        onClose={() => !favBusy && setFavTarget(null)}
        title="Agregar a favoritos"
        subtitle={favTarget?.name}
        footer={<button className="btn btn-ghost" onClick={() => setFavTarget(null)} disabled={favBusy}>Cerrar</button>}
      >
        {collections.length > 0 && (
          <>
            <span className="field-label">Elige una colección</span>
            <div className="fav-col-picklist">
              {collections.map(c => (
                <button key={c.id} className="fav-col-pick" disabled={favBusy} onClick={() => addTargetTo(c.id)}>
                  <span className="fav-col-pick-name">{c.name}</span>
                  <span className="fav-col-pick-count">{(c.items || []).length}</span>
                </button>
              ))}
            </div>
            <div className="fav-col-sep">o crea una nueva</div>
          </>
        )}
        <div className="fav-col-new">
          <input
            className="field-input" autoFocus value={newColName}
            placeholder="Nombre de la colección (p. ej. Mejores Puente)"
            onChange={e => setNewColName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newColName.trim() && !favBusy) createAndAdd() }}
          />
          <button className="btn btn-primary" disabled={favBusy || !newColName.trim()} onClick={createAndAdd}>
            {favBusy ? '...' : 'Crear y guardar'}
          </button>
        </div>
      </Modal>
    </>
  )
}

function GalleryItem({ file, thumbUrl, onThumbLoaded, getSas, onClick, active, fav, onFav, selMode, checked, label, tags = [] }) {
  const [loading, setLoading] = useState(false)
  const ref = useRef(null)
  const prefix = prefixOf(file.name)

  // Lazy load thumbnail only when visible in viewport
  useEffect(() => {
    if (!isImg(file.name) || thumbUrl) return

    const observer = new IntersectionObserver(
      async (entries) => {
        if (entries[0].isIntersecting && !loading) {
          setLoading(true)
          try {
            // Caché compartida entre navegaciones: volver a la semana no re-descarga
            const thumbObjectUrl = await fetchThumb(file.path, { w: 520, q: 68 })
            onThumbLoaded(thumbObjectUrl)
            observer.disconnect()
          } catch (err) {
            // Fallback to original image SAS if thumbnail generation fails.
            try {
              const fallbackUrl = await getSas(file.path, 60)
              onThumbLoaded(fallbackUrl)
              observer.disconnect()
            } catch (fallbackErr) {
              console.error('Failed to load thumbnail:', fallbackErr)
            }
          } finally {
            setLoading(false)
          }
        }
      },
      { rootMargin: '100px' } // Start loading 100px before item enters viewport
    )

    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [file.path, file.name, thumbUrl, loading, onThumbLoaded, getSas])

  const icon = isVid(file.name) ? '▶' : isRaw(file.name) ? 'RAW' : isI360(file.name) ? '360°' : '📄'
  const typeColor = PREFIX_BADGE[prefix] || 'badge-dim'

  return (
    <div ref={ref} className={`gallery-item ${active ? 'active' : ''} ${selMode ? 'sel-mode' : ''} ${selMode && checked ? 'sel-checked' : ''}`} onClick={onClick}>
      {thumbUrl ? (
        <img src={thumbUrl} alt={file.name} loading="lazy" />
      ) : (
        <div className="file-icon">
          <div className="file-icon-sym">{icon}</div>
          <div className="file-icon-name">{file.name}</div>
          {loading && <div className="spinner" style={{ width: 16, height: 16 }} />}
        </div>
      )}
      {selMode ? (
        <span className={`gallery-check ${checked ? 'on' : ''}`} aria-hidden="true">{checked ? '✓' : ''}</span>
      ) : (
        <button
          className={`gallery-fav-btn ${fav ? 'is-fav' : ''}`}
          title={fav ? 'Quitar de favoritos' : 'Agregar a favoritos'}
          aria-label={fav ? 'Quitar de favoritos' : 'Agregar a favoritos'}
          onClick={(e) => { e.stopPropagation(); onFav?.() }}
        >
          <HeartIcon filled={fav} />
        </button>
      )}
      <div className={`gallery-item-type badge ${typeColor}`}>{prefix}</div>
      {tags.length > 0 && <div className="tag-dots" title={tags.map(t => t.label).join(' · ')} aria-label={tags.map(t => t.label).join(', ')}>
        {tags.map(t => <span key={t.id} className={`tag-dot tag-color-${t.color}`} />)}
      </div>}
      <div className="gallery-item-label" title={label || file.name}>{label || file.name}</div>
    </div>
  )
}
