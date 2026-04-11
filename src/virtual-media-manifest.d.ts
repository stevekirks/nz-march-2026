declare module 'virtual:media-manifest' {
  /** Maps visitId (folder name) → array of filenames in that folder */
  const manifest: Record<string, string[]>;
  export default manifest;
}
