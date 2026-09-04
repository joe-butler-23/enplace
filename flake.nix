{
  description = "Enplace release and three-engine Playwright environment";
  inputs = {
    # Node 22.23.1 post-dates Playwright 1.58.2 in nixpkgs, so each comes from its exact revision.
    nixpkgs.url = "github:NixOS/nixpkgs/af9b23694821dcabf121681a98437e76722e0536";
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
            packages = [ pkgs.nodejs_22 ];
            PLAYWRIGHT_BROWSERS_PATH = "${browserDriver.browsers}";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            ENPLACE_NIX_PLAYWRIGHT_VERSION = browserDriver.version;
          };
        });
    };
}
