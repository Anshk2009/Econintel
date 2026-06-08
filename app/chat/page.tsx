'use client'

import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'
import Link from 'next/link'
import { useState, useRef, useEffect } from 'react'

export default function ChatPage() {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return

    const userMessage = { role: 'user', content: input }
    setMessages(prev => [...prev, userMessage])
    setInput('')
    setLoading(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMessage] })
      })

      const data = await response.json()
      if (data.choices?.[0]?.message) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.choices[0].message.content }])
      }
    } catch (error) {
      console.error('Chat error:', error)
      setMessages(prev => [...prev, { role: 'error', content: 'Failed to get response. Check backend.' }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full h-screen bg-black text-white overflow-hidden flex">
      {/* ShaderGradient Background */}
      <ShaderGradientCanvas
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          zIndex: 0,
        }}
        pixelDensity={1.5}
        fov={45}
      >
        <ShaderGradient
          control="props"
          brightness={1.1}
          cAzimuthAngle={180}
          cDistance={3.9}
          cPolarAngle={115}
          cameraZoom={1}
          color1="#5606ff"
          color2="#3d40fe"
          color3="#000000"
          positionX={-0.5}
          positionY={0.1}
          positionZ={0}
          reflection={0.1}
          rotationX={0}
          rotationY={0}
          rotationZ={235}
          type="waterPlane"
        />
      </ShaderGradientCanvas>

      {/* Content */}
      <div className="relative z-10 w-full flex flex-col">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 backdrop-blur-sm bg-black/40">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-bold text-xl hover:text-blue-400 transition">
              EconIntel
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-white/60 hover:text-white transition">
              Home
            </Link>
            <button className="bg-white/5 text-white px-4 py-2 rounded-lg border border-white/10 hover:bg-white/10 transition">
              Upgrade
            </button>
          </div>
        </header>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-xl">
                <h1 className="text-4xl font-black mb-4">What's moving the markets?</h1>
                <p className="text-white/60 mb-8">
                  Ask about crises, currencies, central banks — let's reason through it together.
                </p>
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-6">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-md px-6 py-4 rounded-lg ${
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : msg.role === 'error'
                        ? 'bg-red-500/20 text-red-200 border border-red-500/30'
                        : 'bg-white/10 text-white/90 border border-white/10'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-white/10 text-white/90 px-6 py-4 rounded-lg border border-white/10">
                    Thinking<span className="animate-pulse">...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <form onSubmit={sendMessage} className="px-6 py-6 border-t border-white/10 backdrop-blur-sm bg-black/40">
          <div className="max-w-3xl mx-auto flex gap-4">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about economics..."
              className="flex-1 bg-white/10 text-white px-6 py-4 rounded-lg border border-white/10 focus:border-blue-500 focus:outline-none placeholder-white/40 transition"
            />
            <button
              type="submit"
              disabled={loading}
              className="bg-white text-black px-8 py-4 rounded-lg font-bold hover:bg-blue-400 disabled:opacity-50 transition"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
