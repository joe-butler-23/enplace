{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  # nativeBuildInputs: tools needed at build time (compilers, pkg-config, etc.)
  nativeBuildInputs = with pkgs; [
    pkg-config
    gobject-introspection
    clang
    llvmPackages.lld
    cargo
    rustc
    nodejs_22
    patchelf
  ];

  # buildInputs: libraries linked against
  buildInputs = with pkgs; [
    # Tauri v2 core
    webkitgtk_4_1
    webkitgtk_4_1.dev
    gtk3
    gtk3.dev
    glib
    glib.dev
    libsoup_3
    libsoup_3.dev
    cairo
    cairo.dev
    pango
    pango.dev
    harfbuzz
    harfbuzz.dev
    gdk-pixbuf
    gdk-pixbuf.dev
    atk
    atk.dev
    openssl
    openssl.dev
    zlib
    zlib.dev
    libappindicator-gtk3
    libappindicator-gtk3.dev
    librsvg
    dconf

    # GIO/GSettings runtime (critical for webkit2gtk CSS rendering on NixOS)
    glib-networking
    gsettings-desktop-schemas

    # WebKit media pipeline
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad
    gst_all_1.gst-libav

    # Chromium/Puppeteer runtime libs
    nss
    nspr
    dbus
    dbus.dev
    at-spi2-core
    cups
    expat
    libxkbcommon
    libxcb
    libxshmfence
    libdrm
    mesa
    alsa-lib
    systemd
    libx11
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxrender
    libxcursor
    libxi
    libxtst
    libxinerama
    libxscrnsaver
  ];

  shellHook = ''
    # ── pkg-config ──────────────────────────────────────────────────
    export PKG_CONFIG_PATH=${pkgs.lib.makeSearchPath "lib/pkgconfig" [
      pkgs.glib.dev
      pkgs.gtk3.dev
      pkgs.webkitgtk_4_1.dev
      pkgs.libsoup_3.dev
      pkgs.libappindicator-gtk3.dev
      pkgs.cairo.dev
      pkgs.pango.dev
      pkgs.harfbuzz.dev
      pkgs.gdk-pixbuf.dev
      pkgs.atk.dev
      pkgs.openssl.dev
      pkgs.dbus.dev
    ]}:${pkgs.lib.makeSearchPath "share/pkgconfig" [
      pkgs.glib.dev
      pkgs.gtk3.dev
      pkgs.webkitgtk_4_1.dev
      pkgs.libsoup_3.dev
      pkgs.libappindicator-gtk3.dev
      pkgs.cairo.dev
      pkgs.pango.dev
      pkgs.harfbuzz.dev
      pkgs.gdk-pixbuf.dev
      pkgs.atk.dev
      pkgs.openssl.dev
      pkgs.zlib.dev
      pkgs.dbus.dev
    ]}

    # ── runtime library path ────────────────────────────────────────
    export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath [
      pkgs.glib
      pkgs.glib-networking
      pkgs.gtk3
      pkgs.webkitgtk_4_1
      pkgs.gst_all_1.gstreamer
      pkgs.gst_all_1.gst-plugins-base
      pkgs.gst_all_1.gst-plugins-good
      pkgs.gst_all_1.gst-plugins-bad
      pkgs.gst_all_1.gst-libav
      pkgs.libsoup_3
      pkgs.libappindicator-gtk3
      pkgs.cairo
      pkgs.pango
      pkgs.harfbuzz
      pkgs.gdk-pixbuf
      pkgs.atk
      pkgs.openssl
      pkgs.dconf
      pkgs.nss
      pkgs.nspr
      pkgs.dbus
      pkgs.at-spi2-core
      pkgs.cups
      pkgs.expat
      pkgs.libxkbcommon
      pkgs.libxcb
      pkgs.libxshmfence
      pkgs.libdrm
      pkgs.mesa
      pkgs.alsa-lib
      pkgs.systemd
      pkgs.libx11
      pkgs.libxcomposite
      pkgs.libxdamage
      pkgs.libxext
      pkgs.libxfixes
      pkgs.libxrandr
      pkgs.libxrender
      pkgs.libxcursor
      pkgs.libxi
      pkgs.libxtst
      pkgs.libxinerama
      pkgs.libxscrnsaver
    ]}:''${LD_LIBRARY_PATH:-}
    _mesa_libgbm_dir="$(for dir in /nix/store/*mesa-libgbm*/lib; do test -e "$dir/libgbm.so.1" && echo "$dir"; done | sort -V | tail -1)"
    if [[ -n "$_mesa_libgbm_dir" ]]; then
      export LD_LIBRARY_PATH="$_mesa_libgbm_dir:$LD_LIBRARY_PATH"
    fi

    # ── GSettings schemas ───────────────────────────────────────────
    # webkit2gtk uses GSettings for rendering configuration. Without
    # valid schemas: "g_settings_schema_source_lookup: assertion 'source != NULL' failed"
    #
    # NixOS puts schemas in a non-standard nested path:
    #   share/gsettings-schemas/<pkg-name>/glib-2.0/schemas/
    # We need schemas from BOTH gsettings-desktop-schemas (rendering)
    # AND gtk3 (FileChooser dialog, etc). Compile into a single dir.
    _schema_dir=$(mktemp -d)
    for d in ${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}/glib-2.0/schemas \
             ${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}/glib-2.0/schemas; do
      if [ -d "$d" ]; then
        cp -n "$d"/*.xml "$_schema_dir/" 2>/dev/null || true
        cp -n "$d"/*.override "$_schema_dir/" 2>/dev/null || true
      fi
    done
    ${pkgs.glib.dev}/bin/glib-compile-schemas "$_schema_dir" 2>/dev/null
    export GSETTINGS_SCHEMA_DIR="$_schema_dir"

    # XDG_DATA_DIRS: include NixOS-specific gsettings-schemas paths as fallback
    export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.lib.makeSearchPath "share" [
      pkgs.gtk3
      pkgs.glib
      pkgs.gsettings-desktop-schemas
    ]}:''${XDG_DATA_DIRS:-/run/current-system/sw/share}

    # ── GIO modules (TLS/HTTPS support) ─────────────────────────────
    # Without this, webkit2gtk can't initialise properly on NixOS.
    # See: https://github.com/NixOS/nixpkgs/issues/367378
    #      https://github.com/tauri-apps/tauri/issues/14187
    export GIO_MODULE_DIR=${pkgs.glib-networking}/lib/gio/modules/
    export GIO_EXTRA_MODULES=${pkgs.glib-networking}/lib/gio/modules/

    # ── pixel buffer loaders ────────────────────────────────────────
    export GDK_PIXBUF_MODULE_FILE=${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache

    # ── GStreamer plugins ──────────────────────────────────────────
    export GST_PLUGIN_SYSTEM_PATH_1_0=${pkgs.lib.makeSearchPath "lib/gstreamer-1.0" [
      pkgs.gst_all_1.gstreamer
      pkgs.gst_all_1.gst-plugins-base
      pkgs.gst_all_1.gst-plugins-good
      pkgs.gst_all_1.gst-plugins-bad
      pkgs.gst_all_1.gst-libav
    ]}
    export GST_PLUGIN_PATH_1_0="$GST_PLUGIN_SYSTEM_PATH_1_0"

    # ── webkit2gtk rendering workarounds ────────────────────────────
    # Use safe mode by default to avoid NixOS rendering failures.
    # Set MEP_WEBKIT_SAFE_MODE=0 to test performance mode.
    # Must be exported, not just assigned: src-tauri/src/main.rs reads it to
    # decide whether to force the disable flags itself, and without the export
    # the app never saw it -- performance mode was silently re-disabled.
    : "''${MEP_WEBKIT_SAFE_MODE:=1}"
    export MEP_WEBKIT_SAFE_MODE
    if [ "''${MEP_WEBKIT_SAFE_MODE}" = "1" ]; then
      export WEBKIT_DISABLE_DMABUF_RENDERER=1
      export WEBKIT_DISABLE_COMPOSITING_MODE=1
      unset WEBKIT_FORCE_COMPOSITING_MODE
    else
      unset WEBKIT_DISABLE_COMPOSITING_MODE
      unset WEBKIT_DISABLE_DMABUF_RENDERER
      export WEBKIT_FORCE_COMPOSITING_MODE=1
      export WEBKIT_ACCELERATED_2D_CANVAS=1
      export WEBKIT_ENABLE_THREADED_COMPOSITOR=1
      export WEBKIT_DISABLE_FRAME_RATE_LIMIT=1
    fi

    # Force single web process so env vars propagate to the renderer
    export WEBKIT_USE_SINGLE_WEB_PROCESS=1

    # WebKit inspector — open http://127.0.0.1:1234 in Chrome to debug
    export WEBKIT_INSPECTOR_SERVER=127.0.0.1:1234

    # ── libclang (for bindgen) ──────────────────────────────────────
    export LIBCLANG_PATH=${pkgs.clang.cc.lib}/lib
  '';
}
