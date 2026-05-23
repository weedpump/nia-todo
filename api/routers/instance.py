"""Public instance verification endpoint for native clients."""

from fastapi import APIRouter, Request

from services.instance_config import get_public_instance_info

router = APIRouter(prefix="/api")


@router.get("/instance")
def get_instance(request: Request):
    return get_public_instance_info(request)
