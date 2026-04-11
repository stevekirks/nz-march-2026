/// <reference types="vite/client" />

// Image asset modules
declare module '*.png' {
  const url: string;
  export default url;
}
declare module '*.svg' {
  const url: string;
  export default url;
}
