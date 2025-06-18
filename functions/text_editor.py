from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout,
                             QTextEdit, QPushButton, QFileDialog)
from PySide6.QtCore import Qt

def get_widget():
    # Create main widget
    widget = QWidget()
    main_layout = QVBoxLayout(widget)
    
    # Create text editor
    text_edit = QTextEdit()
    text_edit.setStyleSheet("""
        QTextEdit {
            font-size: 14px;
            padding: 10px;
            background-color: white;
            border: 1px solid #ccc;
            border-radius: 5px;
        }
    """)
    main_layout.addWidget(text_edit)
    
    # Create button layout
    button_layout = QHBoxLayout()
    
    # Create buttons
    save_button = QPushButton('Save')
    load_button = QPushButton('Load')
    clear_button = QPushButton('Clear')
    
    # Style buttons
    button_style = """
        QPushButton {
            font-size: 14px;
            padding: 8px 15px;
            background-color: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            min-width: 80px;
        }
        QPushButton:hover {
            background-color: #45a049;
        }
    """
    save_button.setStyleSheet(button_style)
    load_button.setStyleSheet(button_style)
    clear_button.setStyleSheet(button_style.replace('#4CAF50', '#f44336').replace('#45a049', '#da190b'))
    
    # Connect button signals
    save_button.clicked.connect(lambda: save_file(text_edit))
    load_button.clicked.connect(lambda: load_file(text_edit))
    clear_button.clicked.connect(text_edit.clear)
    
    # Add buttons to layout
    button_layout.addWidget(save_button)
    button_layout.addWidget(load_button)
    button_layout.addWidget(clear_button)
    
    main_layout.addLayout(button_layout)
    return widget

def save_file(text_edit):
    file_name, _ = QFileDialog.getSaveFileName(
        None,
        "Save File",
        "",
        "Text Files (*.txt);;All Files (*)"
    )
    if file_name:
        with open(file_name, 'w', encoding='utf-8') as f:
            f.write(text_edit.toPlainText())

def load_file(text_edit):
    file_name, _ = QFileDialog.getOpenFileName(
        None,
        "Load File",
        "",
        "Text Files (*.txt);;All Files (*)"
    )
    if file_name:
        with open(file_name, 'r', encoding='utf-8') as f:
            text_edit.setText(f.read()) 