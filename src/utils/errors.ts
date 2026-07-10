// Structured business logic error with machine-readable code and HTTP status
export class BusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

// Helper to catch BusinessError in route handlers and return JSON
export function handleRouteError(error: unknown, fallbackMsg = 'Internal Server Error') {
  if (error instanceof BusinessError) {
    return { body: { error: error.message, code: error.code }, status: error.statusCode as 400 | 401 | 403 | 404 };
  }
  console.error(fallbackMsg + ':', error);
  return { body: { error: fallbackMsg }, status: 500 as const };
}
