// Browser origins allowed by CORS and the CSRF origin check. Kept out of app.ts so middleware
// can import it without a circular import (app.ts -> originCheck.ts -> app.ts).
export const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://ruetcse24-new.vercel.app",
  "https://ruetcsearchive.vercel.app",
];
