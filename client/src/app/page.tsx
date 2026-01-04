import Link from "next/link"

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-white">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-4xl font-bold mb-4">Sage</h1>
          <p className="text-xl text-slate-300 mb-8">
            Enterprise AI Assistant Platform
          </p>
          <div className="bg-slate-800/50 rounded-lg p-8 mb-8">
            <h2 className="text-lg font-semibold mb-4">Secure Communication</h2>
            <p className="text-slate-400">
              End-to-end encrypted AI interactions for enterprise teams.
              SOC 2 compliant. GDPR ready.
            </p>
          </div>
          <Link
            href="/chat"
            className="inline-block bg-violet-600 hover:bg-violet-700 px-6 py-3 rounded-lg font-medium transition"
          >
            Access Portal
          </Link>
          <p className="text-sm text-slate-500 mt-8">
            2024 VibeScape Technologies B.V.
          </p>
        </div>
      </div>
    </main>
  )
}
