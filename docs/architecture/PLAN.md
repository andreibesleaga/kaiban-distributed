```mermaid
C4Context
    title C4 Context Diagram
    Person(user, "User")
    System(system, "System")
    Container(container1, "Container 1", "This is container 1")
    Container(container2, "Container 2", "This is container 2")

    Rel(user, system, "Uses")
    Rel(system, container1, "Views state and manages tasks using")
    Rel(system, container2, "Interacts with")
```