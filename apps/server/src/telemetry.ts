export type ServerTelemetryContext = {
  method?: string;
  route?: string;
  surface?: string;
};

export type OpenworkDesktopTelemetry = {
  captureException: (error: unknown, context?: ServerTelemetryContext) => boolean;
};

declare global {
  // Provided by the Electron host when the embedded server runs in desktop mode.
  // The standalone openwork-server package leaves this unset.
  var __openworkDesktopTelemetry: OpenworkDesktopTelemetry | undefined;
}

export function captureServerException(error: unknown, context: ServerTelemetryContext = {}): boolean {
  return globalThis.__openworkDesktopTelemetry?.captureException(error, {
    surface: "server",
    ...context,
  }) ?? false;
}
