{
  description = "scarred-frontier-map";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }: let
    forAllSystems = f: nixpkgs.lib.genAttrs [
      "x86_64-linux"
      "aarch64-darwin"
    ] (system: f nixpkgs.legacyPackages.${system});
  in {
    meta = {
      status = "active";
      stack = [ "node" "typescript" ];
      category = "root";
    };

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_20
        ];
      };
    });
  };
}
