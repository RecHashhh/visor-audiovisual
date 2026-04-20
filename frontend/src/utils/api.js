// src/utils/api.js
import { msalInstance, apiRequest } from '../authConfig'

async function getToken() {
  const account = msalInstance.getActiveAccount()
  if (!account) throw new Error('No active account')
  try {
    const res = await msalInstance.acquireTokenSilent({ ...apiRequest, account })
    return res.accessToken
  } catch {
    const res = await msalInstance.acquireTokenPopup({ ...apiRequest, account })
    return res.accessToken
  }
}

async function apiFetch(path, options = {}) {
  const token = await getToken().catch(() => null)
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`)
  return res.json()
}

export const api = {
  getProjects:  ()                         => apiFetch('/api/projects'),
  getWeeks:     (id)                       => apiFetch(`/api/projects/${id}/weeks`),
  getFiles:     (id, week)                 => apiFetch(`/api/projects/${id}/weeks/${week}/files`),

  // SAS individual — para un archivo
  getSasUrl:    (blobPath, minutes = 60)   =>
    apiFetch('/api/sas/generate', {
      method: 'POST',
      body: JSON.stringify({ blobPath, expiryMinutes: minutes })
    }),

  // SAS en lote — para toda una galería de una sola llamada
  getSasBatch:  (blobPaths, minutes = 60)  =>
    apiFetch('/api/sas/batch', {
      method: 'POST',
      body: JSON.stringify({ blobPaths, expiryMinutes: minutes })
    }),

  rebuildIndex: ()                         =>
    apiFetch('/api/index/rebuild', { method: 'POST' }),

  createShare:  (projectId, week, expiryDays) =>
    apiFetch('/api/share/create', {
      method: 'POST',
      body: JSON.stringify({ projectId, week, expiryDays })
    }),
  listShares:   ()                         => apiFetch('/api/share/list'),
  revokeShare:  (token)                    => apiFetch(`/api/share/${token}`, { method: 'DELETE' }),
  resolveShare: (token)                    => apiFetch(`/api/share/${token}`),
}
