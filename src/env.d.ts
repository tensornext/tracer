// Vite-style asset URL import used by the CAD worker.
declare module "*?url" {
  const url: string;
  export default url;
}

declare module "clipper-lib";
