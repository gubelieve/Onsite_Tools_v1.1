"""Make the ``app`` package importable when pytest runs from the repository root."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def isolated_inventory(tmp_path, monkeypatch):
    """Every test gets its own empty Site Inventory file - never touch the real data/ folder."""
    from app.core import inventory

    monkeypatch.setattr(inventory.store, "path", str(tmp_path / "site_inventory.json"))
    return inventory.store
