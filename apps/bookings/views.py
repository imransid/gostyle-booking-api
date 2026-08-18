from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class MeView(APIView):
    """Proves the whole chain: header → gRPC → customer-api → answer."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({
            "consumer_id": request.user.consumer_id,
            "verified": request.user.verified,
        })