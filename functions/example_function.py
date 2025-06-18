
def get_widget():
    from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel
    widget = QWidget()
    layout = QVBoxLayout(widget)
    label = QLabel("This is an example function")
    layout.addWidget(label)
    return widget
