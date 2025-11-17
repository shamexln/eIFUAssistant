export const environment = {
  production: true,
  // In production we deploy behind Nginx with same-domain reverse proxy.
  // Use relative base so all requests go to the same origin.
  // Services will append paths like "/api/...".
  backendBaseUrl: '/'
};
