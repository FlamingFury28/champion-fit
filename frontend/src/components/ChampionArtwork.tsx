import { useState } from 'react'
import '../champion-experience.css'

/** Use the canonical asset key supplied by Data Dragon, never the display name. */
export function championSplashUrl(iconUrl?: string): string | undefined {
  if (!iconUrl) return undefined
  try {
    const url = new URL(iconUrl)
    if (url.origin !== 'https://ddragon.leagueoflegends.com') return undefined
    const key = /^\/cdn\/[\d.]+\/img\/champion\/([A-Za-z0-9]+)\.png$/.exec(url.pathname)?.[1]
    return key ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${key}_0.jpg` : undefined
  } catch {
    return undefined
  }
}

export function ChampionArtwork({ iconUrl, champion, className = '' }: { iconUrl?: string; champion?: string; className?: string }) {
  const source = championSplashUrl(iconUrl)
  const [failedSource, setFailedSource] = useState<string>()
  const showImage = Boolean(source && source !== failedSource)

  return (
    <div className={`champion-artwork ${className}`} data-illustrated={showImage} aria-hidden="true">
      <svg className="champion-artwork__fallback" viewBox="0 0 360 420" fill="none">
        <circle cx="180" cy="210" r="136" />
        <circle cx="180" cy="210" r="104" />
        <path d="M180 36 326 210 180 384 34 210Z" />
        <path d="m180 108 77 102-77 102-77-102Z" />
        <path d="M180 16v100m0 188v100M0 210h100m160 0h100" />
        <path className="champion-artwork__sigil" d="m180 145 21 44 49 21-49 21-21 44-21-44-49-21 49-21Z" />
      </svg>
      {!showImage ? <span className="champion-artwork__monogram">{champion?.slice(0, 2).toUpperCase() || 'CF'}</span> : null}
      {showImage ? <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailedSource(source)} /> : null}
      <span className="champion-artwork__frame" />
    </div>
  )
}
