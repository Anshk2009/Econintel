'use client'

import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'
import Link from 'next/link'

export default function Home() {
  return (
    <main className="w-full min-h-screen bg-black text-white overflow-hidden">
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
          control="query"
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
      <div className="relative z-10 w-full">
        {/* Navigation */}
        <nav className="fixed top-5 left-0 right-0 z-50 flex justify-center px-4">
          <div className="flex items-center justify-between py-3 px-6 w-full max-w-4xl bg-black/70 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl">
            <Link href="/" className="font-bold text-lg bg-gradient-to-r from-white to-blue-400 bg-clip-text text-transparent">
              EconIntel
            </Link>
            <div className="hidden sm:flex gap-8 text-sm font-medium">
              <a href="#features" className="text-white/60 hover:text-white transition">Terminal</a>
              <a href="#crises" className="text-white/60 hover:text-white transition">Crisis Analogues</a>
              <a href="#pricing" className="text-white/60 hover:text-white transition">Pricing</a>
              <a href="#sources" className="text-white/60 hover:text-white transition">Sources</a>
            </div>
            <Link href="/chat" className="bg-white text-black px-5 py-2 rounded-full font-bold hover:bg-blue-400 transition">
              Sign In
            </Link>
          </div>
        </nav>

        {/* Hero */}
        <section className="min-h-screen flex items-center justify-center pt-20 px-4">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-full px-4 py-2 mb-8">
              <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
              <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Economics, Reimagined</span>
            </div>

            <h1 className="text-6xl md:text-7xl font-black leading-tight mb-6">
              Structured Reasoning, Not News
            </h1>

            <p className="text-xl text-white/60 mb-10 max-w-2xl mx-auto leading-relaxed">
              Ask EconIntel about any economic question. Get sharp, sourced analysis backed by case studies and historical parallels.
            </p>

            <div className="flex gap-4 justify-center flex-wrap">
              <Link
                href="/chat"
                className="bg-white text-black px-8 py-3 rounded-lg font-bold hover:bg-blue-400 transition-all hover:shadow-lg hover:shadow-blue-500/50"
              >
                ENTER TERMINAL
              </Link>
              <button className="bg-white/5 text-white px-8 py-3 rounded-lg font-semibold border border-white/10 hover:bg-white/10 transition">
                Learn More
              </button>
            </div>

            <div className="mt-16 text-white/40 text-sm">
              <p>Trusted by economists, traders, and analysts worldwide</p>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="py-20 px-4">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-4xl font-black text-center mb-16">Why EconIntel</h2>

            <div className="grid md:grid-cols-3 gap-6">
              {[
                { title: 'Structured Analysis', desc: 'Not headlines. Case studies, mechanisms, historical precedent.' },
                { title: 'Real-Time Sources', desc: 'BBC, IMF, World Bank, central banks, and more.' },
                { title: 'Hyperlinked Insights', desc: 'Every claim backed by sources you can verify instantly.' },
              ].map((item, i) => (
                <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-6 hover:bg-white/10 transition">
                  <h3 className="font-bold text-lg mb-3">{item.title}</h3>
                  <p className="text-white/60">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Footer CTA */}
        <section className="py-20 px-4 text-center">
          <div className="max-w-2xl mx-auto">
            <h2 className="text-4xl font-black mb-8">Ready to reason?</h2>
            <Link
              href="/chat"
              className="inline-block bg-white text-black px-8 py-4 rounded-lg font-bold text-lg hover:bg-blue-400 transition-all hover:shadow-lg hover:shadow-blue-500/50"
            >
              Start Analyzing Now
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
