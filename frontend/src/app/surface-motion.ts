import { useEffect, useLayoutEffect, useRef } from 'react'

/** Animate the existing content, preserving focus and live regions across updates. */
export function useContentMotion(identity: string, reveal = false) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || node.hidden || typeof node.animate !== 'function' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const animation = node.animate(reveal
      ? [{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }]
      : [{ opacity: .55, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: reveal ? 240 : 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
    return () => animation.cancel()
  }, [identity, reveal])
  return ref
}

/** A local reflection follows fine pointers; coarse pointers and reduced motion remain still. */
export function useGlassReflection() {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || !window.matchMedia) return
    const allowed = window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)')
    let frame = 0
    const reset = () => {
      cancelAnimationFrame(frame)
      node.style.removeProperty('--glass-x')
      node.style.removeProperty('--glass-y')
    }
    const move = (event: PointerEvent) => {
      if (!allowed.matches || event.pointerType !== 'mouse') return
      const bounds = node.getBoundingClientRect()
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        node.style.setProperty('--glass-x', `${event.clientX - bounds.left}px`)
        node.style.setProperty('--glass-y', `${event.clientY - bounds.top}px`)
      })
    }
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerleave', reset)
    allowed.addEventListener('change', reset)
    return () => {
      reset()
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerleave', reset)
      allowed.removeEventListener('change', reset)
    }
  }, [])
  return ref
}
