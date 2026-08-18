

from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .client import verify_token


class ConsumerJWTAuthentication(BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        header = request.META.get("HTTP_AUTHORIZATION", "")

        # Returning None rather than raising means "I have no opinion", which
        # lets AllowAny views serve anonymous callers normally.
        if not header.startswith(f"{self.keyword} "):
            return None

        token = header[len(self.keyword) + 1:].strip()
        identity = verify_token(token)

        if identity is None:
            raise AuthenticationFailed("Invalid or expired token.")

        # DRF expects (user, auth). There is no user model here, so the
        # Identity itself stands in. request.user.consumer_id is what views
        # read; request.user.is_authenticated keeps DRF's permissions happy.
        identity.is_authenticated = True
        return (identity, token)

    def authenticate_header(self, request):
        # Makes DRF return 401 instead of 403 when no credentials were sent.
        return f'{self.keyword} realm="api"'