from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, 
                             QPushButton, QLineEdit, QLabel)
from PySide6.QtCore import Qt

def get_widget():
    # Create main widget
    widget = QWidget()
    main_layout = QVBoxLayout(widget)
    
    # Create display
    display = QLineEdit()
    display.setAlignment(Qt.AlignRight)
    display.setReadOnly(True)
    display.setStyleSheet("""
        QLineEdit {
            font-size: 24px;
            padding: 10px;
            background-color: #f0f0f0;
            border: 1px solid #ccc;
            border-radius: 5px;
        }
    """)
    main_layout.addWidget(display)
    
    # Create buttons grid
    buttons_layout = QVBoxLayout()
    
    # Button texts
    button_texts = [
        ['7', '8', '9', '/'],
        ['4', '5', '6', '*'],
        ['1', '2', '3', '-'],
        ['0', '.', '=', '+']
    ]
    
    # Create buttons
    for row in button_texts:
        row_layout = QHBoxLayout()
        for text in row:
            button = QPushButton(text)
            button.setStyleSheet("""
                QPushButton {
                    font-size: 18px;
                    padding: 10px;
                    min-width: 60px;
                    background-color: #e0e0e0;
                    border: 1px solid #ccc;
                    border-radius: 5px;
                }
                QPushButton:hover {
                    background-color: #d0d0d0;
                }
            """)
            
            if text == '=':
                button.clicked.connect(lambda: calculate_result(display))
            else:
                button.clicked.connect(lambda checked, t=text: add_to_display(display, t))
            
            row_layout.addWidget(button)
        buttons_layout.addLayout(row_layout)
    
    # Add clear button
    clear_button = QPushButton('Clear')
    clear_button.setStyleSheet("""
        QPushButton {
            font-size: 18px;
            padding: 10px;
            background-color: #ff9999;
            border: 1px solid #cc6666;
            border-radius: 5px;
        }
        QPushButton:hover {
            background-color: #ff6666;
        }
    """)
    clear_button.clicked.connect(lambda: display.clear())
    buttons_layout.addWidget(clear_button)
    
    main_layout.addLayout(buttons_layout)
    return widget

def add_to_display(display, text):
    current_text = display.text()
    display.setText(current_text + text)

def calculate_result(display):
    try:
        expression = display.text()
        result = eval(expression)
        display.setText(str(result))
    except Exception as e:
        display.setText('Error') 