import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './tokens.css'
import './app.css'

createRoot(document.getElementById('root')!).render(<App />)
