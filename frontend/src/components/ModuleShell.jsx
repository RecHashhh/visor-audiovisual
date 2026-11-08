// Encabezado de los módulos que se abren desde la pantalla de inicio (Hardware): sin el menú de Audiovisual.
import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import TopBar from './TopBar'

export default function ModuleShell({ title }) {
  useEffect(() => { document.title = `${title} · RIPCON Hub` }, [title])
  return <div className="shell shell-module">
    <div className="shell-main">
      <TopBar title={title} />
      <main className="main"><Outlet /></main>
    </div>
  </div>
}
