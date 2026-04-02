{
  description = "scarred-frontier-map";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
  in {
    meta = {
      status = "active";
      stack = [ "node" "typescript" ];
      category = "root";
    };

    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [
        nodejs_20
        nodePackages.typescript
      ];
    };
  };
}
