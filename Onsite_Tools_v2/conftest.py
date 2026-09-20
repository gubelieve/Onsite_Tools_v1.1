"""Make the ``app`` package importable when pytest runs from the repository root."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
