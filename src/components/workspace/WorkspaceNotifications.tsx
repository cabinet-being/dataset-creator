import { AlertCircle, Check, Info, X } from 'lucide-react';
import { useUIStore } from '../../stores/useUIStore';

export function WorkspaceNotifications() {
  const notifications = useUIStore(state => state.notifications);
  const removeNotification = useUIStore(state => state.removeNotification);
  if (!notifications.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
      {notifications.map((notification) => {
        const isError = notification.type === 'error';
        const isSuccess = notification.type === 'success';
        const isWarning = notification.type === 'warning';
        return (
          <div
            key={notification.id}
            role={isError ? "alert" : "status"}
            className={`pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-3 text-sm shadow-xl ${
              isError
                ? 'border-destructive/60 bg-destructive text-destructive-foreground'
                : isSuccess
                  ? 'border-emerald-500/60 bg-emerald-950 text-emerald-100'
                  : 'border-border bg-card text-foreground'
            }`}
          >
            {isError || isWarning ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : isSuccess ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
            <p className="min-w-0 flex-1 break-words">{notification.message}</p>
            <button
              type="button"
              onClick={() => removeNotification(notification.id)}
              className="shrink-0 rounded p-0.5 opacity-80 transition-opacity hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
