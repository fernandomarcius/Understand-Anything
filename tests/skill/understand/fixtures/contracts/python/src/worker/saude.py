from http.server import BaseHTTPRequestHandler


class Saude(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/livez":
            self.send_response(200)
        else:
            self.send_response(404)
