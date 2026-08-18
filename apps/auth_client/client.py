

from dataclasses import dataclass

import grpc
from django.conf import settings

from apps.grpc_gen import auth_pb2, auth_pb2_grpc

_channel = grpc.insecure_channel(settings.CONSUMER_GRPC_ADDR)
_client = auth_pb2_grpc.ConsumerAuthStub(_channel)


@dataclass
class Identity:
    consumer_id: str
    verified: bool
    is_authenticated: bool = True


def verify_token(token: str) -> Identity | None:
    """
    Ask customer-api whether this token is good.

    Returns None for a bad token, which is an ORDINARY answer, not an error.
    A gRPC exception here means the call itself failed (customer-api down,
    network gone) and is left to propagate: a 500 is honest, while pretending
    the token was merely invalid would hide an outage.
    """
    reply = _client.VerifyConsumer(
        auth_pb2.VerifyConsumerRequest(token=token),
        timeout=settings.CONSUMER_GRPC_TIMEOUT,
    )

    if not reply.valid:
        return None

    return Identity(consumer_id=reply.consumer_id, verified=reply.verified)