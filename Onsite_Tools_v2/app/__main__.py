"""Entry point: ``python -m app`` starts the web server and opens the browser."""
import argparse
import socket
import sys
import threading
import webbrowser

from .core.paths import ensure_dirs, load_settings


def _port_free(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main():
    settings = load_settings()
    ap = argparse.ArgumentParser(description="Onsite Tools v2 web server")
    ap.add_argument("--host", default=settings.get("host", "127.0.0.1"),
                    help="bind address (use 0.0.0.0 to allow other PCs on the LAN)")
    ap.add_argument("--port", type=int, default=int(settings.get("port", 8088)))
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    args = ap.parse_args()

    ensure_dirs()
    port = args.port
    while not _port_free(args.host, port) and port < args.port + 20:
        port += 1
    if port != args.port:
        print(f"Port {args.port} busy, using {port}")

    url_host = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
    url = f"http://{url_host}:{port}"
    print("=" * 60)
    print(f"  Onsite Tools v2  ->  {url}")
    print("  Press CTRL+C to stop the server.")
    print("=" * 60)
    if settings.get("open_browser", True) and not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    import uvicorn

    uvicorn.run("app.main:app", host=args.host, port=port, log_level="warning")


if __name__ == "__main__":
    sys.exit(main())
