import { Toast } from 'radix-ui'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type PropsWithChildren } from 'react'

type ToastTone = 'success' | 'error' | 'info'

interface ToastMessage { id: number; title: string; description?: string; tone: ToastTone }
interface ToastContextValue { notify: (title: string, options?: { description?: string; tone?: ToastTone }) => void }

const ToastContext = createContext<ToastContextValue | null>(null)

export function AppToastProvider({ children }: PropsWithChildren) {
  const [messages, setMessages] = useState<ToastMessage[]>([])
  const nextId = useRef(0)
  const notify = useCallback((title: string, options?: { description?: string; tone?: ToastTone }) => {
    const message: ToastMessage = {
      id: nextId.current++,
      title,
      description: options?.description,
      tone: options?.tone ?? 'info',
    }
    setMessages((current) => [...current, message])
  }, [])
  const value = useMemo(() => ({ notify }), [notify])
  const message = messages[0]
  const pendingCount = messages.length - 1
  return (
    <ToastContext value={value}>
      <Toast.Provider swipeDirection="right" label="Notifica">
        {children}
        {message ? (
          <Toast.Root
            key={message.id}
            className="toast-root"
            data-tone={message.tone}
            duration={4200}
            style={{ touchAction: 'pan-y' }}
            onOpenChange={(open) => {
              if (!open) setMessages((current) => current.filter((item) => item.id !== message.id))
            }}
          >
            {message.tone === 'error' ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
            <div>
              <Toast.Title className="toast-title">{message.title}</Toast.Title>
              {message.description ? <Toast.Description className="toast-description" tabIndex={0} role="region" aria-label="Dettagli della notifica">{message.description}</Toast.Description> : null}
              {pendingCount > 0 ? <span className="toast-pending">{pendingCount} {pendingCount === 1 ? 'notifica in attesa' : 'notifiche in attesa'}</span> : null}
            </div>
            <Toast.Close className="icon-button" aria-label="Chiudi notifica"><X aria-hidden="true" /></Toast.Close>
          </Toast.Root>
        ) : null}
        <Toast.Viewport className="toast-viewport" label="Notifiche ({hotkey})" />
      </Toast.Provider>
    </ToastContext>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast deve essere usato dentro AppToastProvider')
  return context
}
