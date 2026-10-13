// esbuild bundles the font files as data: URLs (scripts/build.ts, loader "dataurl").
declare module "*.woff2" {
  const url: string;
  export default url;
}
