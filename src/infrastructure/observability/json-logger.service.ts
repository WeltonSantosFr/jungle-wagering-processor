import { ConsoleLogger, Injectable } from '@nestjs/common';

const REDACTED_KEYS = new Set(['money', 'balance', 'amount', 'initialBalance', 'storedBalance', 'calculatedBalance']);

function sanitizeLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACTED_KEYS.has(key)) {
      clean[key] = '[REDACTED_FINANCIAL_DATA]';
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

@Injectable()
export class StructuredJsonLogger extends ConsoleLogger {
  log(message: unknown, context?: string) {
    this.emitJson('INFO', message, context);
  }

  warn(message: unknown, context?: string) {
    this.emitJson('WARN', message, context);
  }

  error(message: unknown, trace?: string, context?: string) {
    this.emitJson('ERROR', message, context, trace);
  }

  private emitJson(level: string, message: unknown, context?: string, trace?: string) {
    // Silencia logs verbosos durante testes automatizados se LOG_SILENT=true
    if (process.env.LOG_SILENT === 'true') return;

    const payload =
      typeof message === 'object' && message !== null
        ? sanitizeLogObject(message as Record<string, unknown>)
        : { message: String(message) };

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? this.context ?? 'Application',
      ...payload,
      ...(trace ? { trace } : {}),
    };

    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}