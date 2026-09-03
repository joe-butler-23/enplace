declare module "*.js?raw" {
  const content: string;
  export default content;
}


declare module "*.pack?url&no-inline" {
  const url: string;
  export default url;
}
