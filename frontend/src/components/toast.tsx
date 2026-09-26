import { Toast } from 'radix-ui'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react'

type ToastTone = 'success' | 'error' | 'info'

interface ToastMessage { id: number; title: string; description?: string; tone: ToastTone }
interface ToastContextValue { notify: (title: string, options?: { description?: string; tone?: ToastTone }) => void }

const ToastContext = createContext<ToastContextValue | null>(null)

export function AppToastProvider({ children }: PropsWithChildren) {
  const [messages, setMessages] = useState<ToastMessage[]>([])
  const notify = useCallback((title: string, options?: { description?: string; tone?: ToastTone }) => {
    setMessages((current) => [...current, {
      id: Date.now() + current.length,
      title,
      description: options?.description,
      tone: options?.tone ?? 'info',
    }])
  }, [])
  const value = useMemo(() => ({ notify }), [notify])
  return (
    <ToastContext value={value}>
      <Toast.Provider swipeDirection="right" label="Notifica">
        {children}
        {messages.map((message) => (
          <Toast.Root
            key={message.id}
            className="toast-root"
            data-tone={message.tone}
            duration={4200}
            onOpenChange={(open) => {
              if (!open) setMessages((current) => current.filter((item) => item.id !== message.id))
            }}
          >
            {message.tone === 'error' ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
            <div>
              <Toast.Title>{message.title}</Toast.Title>
              {message.description ? <Toast.Description>{message.description}</Toast.Description> : null}
            </div>
            <Toast.Close className="icon-button" aria-label="Chiudi notifica"><X aria-hidden="true" /></Toast.Close>
          </Toast.Root>
        ))}
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
