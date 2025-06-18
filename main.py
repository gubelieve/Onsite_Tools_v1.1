import sys
import os
import importlib.util
from PySide6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, 
                             QHBoxLayout, QListWidget, QStackedWidget, QLabel)
from PySide6.QtCore import Qt

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Function Selector")
        self.setMinimumSize(800, 600)
        
        # Create main widget and layout
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        layout = QHBoxLayout(main_widget)
        
        # Create left panel for function list
        self.function_list = QListWidget()
        self.function_list.setMinimumWidth(200)
        self.function_list.currentItemChanged.connect(self.function_selected)
        
        # Create right panel for function content
        self.content_stack = QStackedWidget()
        
        # Add widgets to main layout
        layout.addWidget(self.function_list)
        layout.addWidget(self.content_stack)
        
        # Load functions from the functions directory
        self.load_functions()
        
    def load_functions(self):
        functions_dir = "functions"
        if not os.path.exists(functions_dir):
            os.makedirs(functions_dir)
            
        # Add a placeholder function
        self.add_placeholder_function()
        
        # Load all .py files from the functions directory
        for file in os.listdir(functions_dir):
            if file.endswith('.py'):
                function_name = file[:-3]  # Remove .py extension
                self.function_list.addItem(function_name)
                
    def add_placeholder_function(self):
        # Create a placeholder function file
        placeholder_path = os.path.join("functions", "example_function.py")
        if not os.path.exists(placeholder_path):
            with open(placeholder_path, 'w') as f:
                f.write("""
def get_widget():
    from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel
    widget = QWidget()
    layout = QVBoxLayout(widget)
    label = QLabel("This is an example function")
    layout.addWidget(label)
    return widget
""")
    
    def function_selected(self, current, previous):
        if current is None:
            return
            
        function_name = current.text()
        try:
            # Import the selected function module
            spec = importlib.util.spec_from_file_location(
                function_name,
                os.path.join("functions", f"{function_name}.py")
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            
            # Get the widget from the function
            widget = module.get_widget()
            
            # Clear previous widgets and add the new one
            while self.content_stack.count():
                self.content_stack.removeWidget(self.content_stack.widget(0))
            
            self.content_stack.addWidget(widget)
            
        except Exception as e:
            # Create error widget
            error_widget = QWidget()
            layout = QVBoxLayout(error_widget)
            error_label = QLabel(f"Error loading function: {str(e)}")
            layout.addWidget(error_label)
            self.content_stack.addWidget(error_widget)

if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec()) 