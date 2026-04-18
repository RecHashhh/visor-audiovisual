// src/App.jsx
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import ProjectsPage from './pages/ProjectsPage'
import WeeksPage from './pages/WeeksPage'
import GalleryPage from './pages/GalleryPage'
import SharePage from './pages/SharePage'
import TopBar from './components/TopBar'

function RequireAuth({ children }) {
  const isAuth = useIsAuthenticated()
  if (!isAuth) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  const isAuth = useIsAuthenticated()
  return (
    <div className="layout">
      {isAuth && <TopBar />}
      <main className="main">
        <Routes>
          <Route path="/login"   element={<LoginPage />} />
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/"        element={<RequireAuth><ProjectsPage /></RequireAuth>} />
          <Route path="/project/:id" element={<RequireAuth><WeeksPage /></RequireAuth>} />
          <Route path="/project/:id/week/:week" element={<RequireAuth><GalleryPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
