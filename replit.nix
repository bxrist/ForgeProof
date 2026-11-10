{pkgs}: {
  deps = [
    pkgs.mesa
    pkgs.libxkbcommon
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libxcb
    pkgs.xorg.libX11
    pkgs.cairo
    pkgs.pango
    pkgs.alsa-lib
    pkgs.expat
    pkgs.dbus
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
    pkgs.chromium
  ];
}
