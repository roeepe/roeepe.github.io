package io.github.roeepe.ivrit

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.roeepe.ivrit.engine.WhisperContext
import io.github.roeepe.ivrit.engine.WhisperNative
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    HomeScreen()
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen() {
    var systemInfo by remember { mutableStateOf<String?>(null) }
    var benchResult by remember { mutableStateOf<String?>(null) }
    var benchRunning by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { systemInfo = WhisperContext.systemInfo() }

    Scaffold(
        topBar = { TopAppBar(title = { Text("תמלול ivrit-ai") }) }
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .padding(16.dp)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "אפליקציה נייטיבית, whisper.cpp על המכשיר. הגרסה הזאת מוודאת שהשכבה " +
                    "הנייטיבית נטענת ומודדת את תפוקת המעבד — הבסיס להערכת הזמן.",
                style = MaterialTheme.typography.bodyMedium,
            )

            ElevatedCard {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("מנוע", style = MaterialTheme.typography.titleSmall)
                    Text(
                        systemInfo ?: "טוען…",
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Start,
                    )
                    Text(
                        "ליבות זמינות: ${Runtime.getRuntime().availableProcessors()} · " +
                            "חוטים לתמלול: ${WhisperContext.defaultThreads()}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            ElevatedCard {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("מדידת תפוקה (ggml matmul)", style = MaterialTheme.typography.titleSmall)
                    Button(
                        enabled = !benchRunning,
                        onClick = {
                            benchRunning = true
                            scope.launch {
                                benchResult = withContext(Dispatchers.Default) {
                                    runCatching {
                                        WhisperNative.ensureLoaded().getOrThrow()
                                        WhisperNative.benchMatmul(WhisperContext.defaultThreads())
                                    }.getOrElse { "נכשל: ${it.message}" }
                                }
                                benchRunning = false
                            }
                        },
                    ) { Text(if (benchRunning) "מודד…" else "הרצת מדידה") }

                    benchResult?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
