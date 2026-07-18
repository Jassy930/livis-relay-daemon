"""Hermes plugin entry point for the LiViS relay bridge."""

# Hermes imports this directory as a real package and therefore always takes
# the relative-import branch.  Pytest also imports a parent ``__init__.py``
# while collecting tests, but a plugin directory named ``hermes-plugin`` isn't
# a valid Python package name and arrives without package context.  Avoid
# importing the Hermes-only adapter in that collection-only case; tests load it
# explicitly after installing narrow public-interface doubles.
if __package__:
    from .adapter import register
else:  # pragma: no cover - exercised by pytest's package setup, not a test item
    register = None

__all__ = ["register"]
