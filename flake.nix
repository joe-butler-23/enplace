{
  description = "Enplace release and three-engine Playwright environment";
  inputs = {
    # Node LTS and the version-matched Playwright browsers have independent release pins.
    nixpkgs.url = "github:NixOS/nixpkgs/0968519e14f7aa7d3e9b389682bd74d2b51c8ce8";
    playwright-nixpkgs.url = "github:NixOS/nixpkgs/7f6a6fb1c76e09426d6125e7e2543efe2a7f74e3";
  };
  outputs = { nixpkgs, playwright-nixpkgs, ... }:
    let systems = [ "x86_64-linux" "aarch64-linux" ];
    in {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          browserDriver = (import playwright-nixpkgs { inherit system; }).playwright-driver;
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 ];
            PLAYWRIGHT_BROWSERS_PATH = "${browserDriver.browsers}";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            ENPLACE_NIX_PLAYWRIGHT_VERSION = browserDriver.version;
          };
        });
    };
}
