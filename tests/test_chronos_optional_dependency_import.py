import builtins
import importlib
import sys


def test_chronos_trainer_imports_without_torch(monkeypatch):
    module_name = "ml.demand_forecasting.chronos_trainer"
    original_module = sys.modules.get(module_name)
    sys.modules.pop(module_name, None)

    real_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "torch" or name.startswith("torch."):
            raise ImportError("torch unavailable for test")
        if name == "chronos" or name.startswith("chronos."):
            raise ImportError("chronos unavailable for test")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    try:
        module = importlib.import_module(module_name)
        trainer = module.ChronosTrainer()
        assert trainer._torch_available is False
        assert trainer.model is None
    finally:
        sys.modules.pop(module_name, None)
        if original_module is not None:
            sys.modules[module_name] = original_module
