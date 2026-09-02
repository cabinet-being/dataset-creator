import { useUIStore } from '../../stores/useUIStore';

export type ApplicationLogLevel = 'info' | 'warning' | 'error' | 'success';

export type OperationProgress = {
  current: number;
  total: number;
  label?: string;
};

export type OperationLogger = {
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  progress: (progress: OperationProgress) => void;
};

const writeLog = (level: ApplicationLogLevel, message: string) => {
  useUIStore.getState().addOperationLog(level, message);
};

export const appLog = {
  info: (message: string) => writeLog('info', message),
  warning: (message: string) => writeLog('warning', message),
  error: (message: string) => writeLog('error', message),
  success: (message: string) => writeLog('success', message),
};

export const createOperationLogger = (area: string): OperationLogger => {
  const prefix = (message: string) => `${area}: ${message}`;

  return {
    info: (message) => appLog.info(prefix(message)),
    warning: (message) => appLog.warning(prefix(message)),
    error: (message) => appLog.error(prefix(message)),
    success: (message) => appLog.success(prefix(message)),
    progress: ({ current, total, label }) => {
      const percent = total > 0 ? ` (${Math.round((current / total) * 100)}%)` : '';
      appLog.info(prefix(`${label ? `${label} ` : ''}${current} / ${total}${percent}`));
    },
  };
};

export const shouldLogProgress = (current: number, total: number): boolean => {
  if (current === 1 || current === total) {
    return true;
  }

  if (total <= 20) {
    return current % 5 === 0;
  }

  const interval = Math.max(10, Math.floor(total / 10));
  return current % interval === 0;
};
