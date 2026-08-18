
from django.contrib import admin
from django.urls import path
from apps.bookings.views import MeView


urlpatterns = [
    path('admin/', admin.site.urls),
    path("api/v1/me", MeView.as_view()),
]
