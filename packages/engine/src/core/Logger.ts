export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>;
  scope: string;
  message: string;
  time: number;
}

/**
 * Scoped, leveled logger that also keeps a bounded in-memory record so the
 * capture tool (and tests) can assert "no warnings or errors were logged".
 */
export class Logger {
  private static level: LogLevel = 'info';
  private static readonly records: LogRecord[] = [];
  private static readonly maxRecords = 500;

  static setLevel(level: LogLevel): void {
    Logger.level = level;
  }

  static getLevel(): LogLevel {
    return Logger.level;
  }

  /** Records at or above `warn`, newest last. Cleared by `clearRecords()`. */
  static getRecords(): readonly LogRecord[] {
    return Logger.records;
  }

  static clearRecords(): void {
    Logger.records.length = 0;
  }

  constructor(readonly scope: string) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, args: unknown[]): void {
    if (LEVEL_RANK[level] >= LEVEL_RANK.warn) {
      Logger.records.push({ level, scope: this.scope, message, time: Date.now() });
      if (Logger.records.length > Logger.maxRecords) Logger.records.shift();
    }
    if (LEVEL_RANK[level] < LEVEL_RANK[Logger.level]) return;
    const line = `[spark:${this.scope}] ${message}`;
    switch (level) {
      case 'debug':
        console.debug(line, ...args);
        break;
      case 'info':
        console.info(line, ...args);
        break;
      case 'warn':
        console.warn(line, ...args);
        break;
      case 'error':
        console.error(line, ...args);
        break;
    }
  }
}
