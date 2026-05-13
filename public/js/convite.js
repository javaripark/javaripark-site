
        // Variáveis globais para o estado da aplicação
        let currentStep = 1;
        let uploadedImage = null;
        let croppedImageBlob = null;
        let selectedDate = null;

        // Elementos do DOM
        const appContainer = document.getElementById('app-container');
        const steps = {
            1: document.getElementById('step-1'),
            2: document.getElementById('step-2'),
            3: document.getElementById('step-3'),
            4: document.getElementById('step-4')
        };

        // Passo 1 - Upload
        const imageUploadInput = document.getElementById('imageUpload');
        const imagePreviewContainer = document.getElementById('imagePreviewContainer');
        const imagePreview = document.getElementById('imagePreview');
        const confirmUploadBtn = document.getElementById('confirmUploadBtn');

        // Passo 2 - Crop
        const cropCanvasContainer = document.getElementById('crop-canvas-container');
        const cropCanvas = document.getElementById('cropCanvas');
        const cropCtx = cropCanvas.getContext('2d');
        const cropOverlay = document.getElementById('crop-overlay');
        const confirmCropBtn = document.getElementById('confirmCropBtn');
        const backToStep1Btn = document.getElementById('backToStep1Btn');

        let cropImageScale = 1;
        let cropImagePosX = 0;
        let cropImagePosY = 0;
        let isDragging = false;
        let startDragX, startDragY;
        let initialPinchDistance = 0; // For pinch-to-zoom

        // Passo 3 - Data
        const eventDateInput = document.getElementById('eventDate');
        const confirmDateBtn = document.getElementById('confirmDateBtn');
        const backToStep2Btn = document.getElementById('backToStep2Btn');

        // Passo 4 - Final
        const finalInvitationCanvas = document.getElementById('finalInvitationCanvas');
        const finalCtx = finalInvitationCanvas.getContext('2d');
        const finalInvitationImage = document.getElementById('finalInvitationImage'); // Novo elemento de imagem
        const downloadBtn = document.getElementById('downloadBtn');
        const backToStep3Btn = document.getElementById('backToStep3Btn');
        const downloadInstructions = document.getElementById('downloadInstructions'); // Novo elemento para instruções

        // Alerta Personalizado
        const customAlert = document.getElementById('customAlert');
        const alertMessage = document.getElementById('alertMessage');

        // --- Constantes de Dimensões (convertidas de mm para pixels a 300 DPI) ---
        const DPI = 300;
        const MM_PER_INCH = 25.4;
        const PX_PER_MM = DPI / MM_PER_INCH; // Aproximadamente 11.811

        const TEMPLATE_WIDTH_PX = 105 * PX_PER_MM; // 1240.15px
        const TEMPLATE_HEIGHT_PX = 148 * PX_PER_MM; // 1748.05px

        // Dimensões da foto dentro do template (agora garantido como quadrado)
        const PHOTO_WIDTH_PX = 49.3 * PX_PER_MM; // 582.25px
        const PHOTO_HEIGHT_PX = 49.3 * PX_PER_MM; // 582.25px (Ajustado para ser quadrado, conforme exemplo visual)
        const PHOTO_X_OFFSET_PX = 49 * PX_PER_MM; // 578.75px
        const PHOTO_Y_OFFSET_PX = 45 * PX_PER_MM; // 531.49px

        const DATE_X_OFFSET_PX = 5.4 * PX_PER_MM; // 63.78px
        const DATE_Y_OFFSET_PX = 66.2 * PX_PER_MM; // 781.82px

        const DAY_OF_WEEK_FONT_SIZE_PX = 20 * (DPI / 72); // Aproximadamente 83.33px
        const DAY_MONTH_TIME_FONT_SIZE_PX = 11 * (DPI / 72); // Aproximadamente 45.83px

        // --- Funções de Detecção de Dispositivo ---
        function isIOS() {
            return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        }

        function isAndroid() {
            return /Android/i.test(navigator.userAgent);
        }

        function isMobileDevice() {
            return isIOS() || isAndroid();
        }

        // --- Funções de Navegação entre Passos ---
        function showStep(stepNumber) {
            steps[currentStep].classList.remove('active');
            currentStep = stepNumber;
            steps[currentStep].classList.add('active');
            window.scrollTo({ top: 0, behavior: 'smooth' }); // Rola para o topo ao mudar de passo

            // Ações específicas ao mostrar cada passo
            if (currentStep === 2 && uploadedImage) {
                // Garante que o cropper seja inicializado APENAS quando a imagem estiver carregada
                initCropper();
            } else if (currentStep === 4) {
                generateFinalInvitation();
            }
        }

        // --- Funções de Alerta Personalizado ---
        function showAlert(message) {
            alertMessage.textContent = message;
            customAlert.style.display = 'flex'; // Exibe o modal
        }

        function hideAlert() {
            customAlert.style.display = 'none'; // Esconde o modal
        }

        // --- Passo 1: Upload de Foto ---
        imageUploadInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    imagePreview.src = e.target.result;
                    imagePreviewContainer.classList.remove('hidden');
                    confirmUploadBtn.disabled = false;
                    uploadedImage = new Image();
                    uploadedImage.src = e.target.result;
                    uploadedImage.onload = () => {
                        // A imagem foi carregada, agora podemos chamar initCropper se já estivermos no passo 2
                        // ou quando o usuário avançar para o passo 2.
                        // O initCropper será chamado na função showStep(2)
                    };
                };
                reader.readAsDataURL(file);
            } else {
                imagePreview.src = '#';
                imagePreviewContainer.classList.add('hidden');
                confirmUploadBtn.disabled = true;
                uploadedImage = null;
            }
        });

        confirmUploadBtn.addEventListener('click', () => {
            if (uploadedImage) {
                showStep(2);
            }
        });

        // --- Passo 2: Módulo de Crop ---
        function initCropper() {
            if (!uploadedImage || !uploadedImage.complete) {
                // Se a imagem ainda não carregou, tenta novamente em breve
                setTimeout(initCropper, 100);
                return;
            }

            cropCanvas.width = cropCanvasContainer.offsetWidth;
            cropCanvas.height = cropCanvasContainer.offsetHeight;

            // Calcula o tamanho da sobreposição de recorte para ser um quadrado
            // que se ajuste ao canvas de crop, mantendo uma margem.
            // A proporção da foto final é 1:1 (quadrado).
            const minCanvasDim = Math.min(cropCanvas.width, cropCanvas.height);
            const cropOverlayVisualSize = minCanvasDim * 0.7; // Usa 70% da menor dimensão do canvas de crop para o quadrado

            cropOverlay.style.width = `${cropOverlayVisualSize}px`;
            cropOverlay.style.height = `${cropOverlayVisualSize}px`;

            // Centraliza a sobreposição visualmente
            cropOverlay.style.left = `50%`;
            cropOverlay.style.top = `50%`;
            cropOverlay.style.transform = `translate(-50%, -50%)`;


            // Calcula a escala inicial para que a imagem preencha completamente a área de crop (o quadrado).
            // A imagem deve ser grande o suficiente para cobrir a área de crop
            const scaleX = cropOverlayVisualSize / uploadedImage.width;
            const scaleY = cropOverlayVisualSize / uploadedImage.height;
            cropImageScale = Math.max(scaleX, scaleY); // Usa a maior escala para garantir que a área seja coberta

            // Centraliza a imagem inicialmente dentro do canvas de crop
            cropImagePosX = (cropCanvas.width / 2) - (uploadedImage.width * cropImageScale / 2);
            cropImagePosY = (cropCanvas.height / 2) - (uploadedImage.height * cropImageScale / 2);

            drawCropper();
        }

        function drawCropper() {
            cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);

            // Calcula os limites da área de recorte no canvas de crop
            const cropOverlayRect = cropOverlay.getBoundingClientRect();
            const canvasRect = cropCanvas.getBoundingClientRect();

            const overlayLeft = cropOverlayRect.left - canvasRect.left;
            const overlayTop = cropOverlayRect.top - canvasRect.top;
            const overlayRight = overlayLeft + cropOverlay.offsetWidth;
            const overlayBottom = overlayTop + cropOverlay.offsetHeight;

            // Calcula o tamanho renderizado da imagem
            const renderedImgWidth = uploadedImage.width * cropImageScale;
            const renderedImgHeight = uploadedImage.height * cropImageScale;

            // Aplica as travas de movimentação para evitar espaços vazios
            // Garante que a imagem sempre cubra a área de recorte
            if (renderedImgWidth < cropOverlay.offsetWidth) { // Se a imagem for menor que o overlay, centraliza e não permite mover
                cropImagePosX = overlayLeft + (cropOverlay.offsetWidth - renderedImgWidth) / 2;
            } else {
                // Limites para X
                const minX = overlayRight - renderedImgWidth;
                const maxX = overlayLeft;
                cropImagePosX = Math.max(minX, Math.min(cropImagePosX, maxX));
            }

            if (renderedImgHeight < cropOverlay.offsetHeight) { // Se a imagem for menor que o overlay, centraliza e não permite mover
                cropImagePosY = overlayTop + (cropOverlay.offsetHeight - renderedImgHeight) / 2;
            } else {
                // Limites para Y
                const minY = overlayBottom - renderedImgHeight;
                const maxY = overlayTop;
                cropImagePosY = Math.max(minY, Math.min(cropImagePosY, maxY));
            }

            // Desenha a imagem do usuário com as posições ajustadas
            cropCtx.drawImage(
                uploadedImage,
                cropImagePosX,
                cropImagePosY,
                renderedImgWidth,
                renderedImgHeight
            );
        }

        // Eventos de arrastar e zoom para o crop (Mouse e Touch)
        cropCanvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            startDragX = e.clientX - cropCanvas.getBoundingClientRect().left - cropImagePosX;
            startDragY = e.clientY - cropCanvas.getBoundingClientRect().top - cropImagePosY;
        });

        cropCanvas.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            cropImagePosX = e.clientX - cropCanvas.getBoundingClientRect().left - startDragX;
            cropImagePosY = e.clientY - cropCanvas.getBoundingClientRect().top - startDragY;
            drawCropper(); // Chama drawCropper para aplicar as travas em tempo real
        });

        cropCanvas.addEventListener('mouseup', () => {
            isDragging = false;
        });

        cropCanvas.addEventListener('mouseleave', () => {
            isDragging = false;
        });

        // Evento de roda do mouse para zoom
        cropCanvas.addEventListener('wheel', (e) => {
            e.preventDefault(); // Impede o scroll da página
            const scaleAmount = 0.05; // Ajuste a sensibilidade do zoom
            const mouseX = e.clientX - cropCanvas.getBoundingClientRect().left;
            const mouseY = e.clientY - cropCanvas.getBoundingClientRect().top;

            const oldScale = cropImageScale;

            if (e.deltaY < 0) {
                cropImageScale *= (1 + scaleAmount); // Zoom in
            } else {
                cropImageScale *= (1 - scaleAmount); // Zoom out
            }

            // Garante que a imagem seja sempre grande o suficiente para cobrir o overlay
            const minScaleX = cropOverlay.offsetWidth / uploadedImage.width;
            const minScaleY = cropOverlay.offsetHeight / uploadedImage.height;
            cropImageScale = Math.max(cropImageScale, Math.max(minScaleX, minScaleY));

            // Limita o zoom máximo (opcional, mas boa prática)
            cropImageScale = Math.min(cropImageScale, 5); // Não pode ser muito grande

            // Ajusta a posição para o zoom ser no centro do mouse
            cropImagePosX = mouseX - ((mouseX - cropImagePosX) * (cropImageScale / oldScale));
            cropImagePosY = mouseY - ((mouseY - cropImagePosY) * (cropImageScale / oldScale));

            drawCropper(); // Chama drawCropper para aplicar as travas após o zoom
        });

        // Touch events for mobile (pan and pinch-to-zoom)
        cropCanvas.addEventListener('touchstart', (e) => {
            e.preventDefault(); // Prevent default touch behavior (like scrolling/zooming page)
            if (e.touches.length === 1) {
                isDragging = true;
                startDragX = e.touches[0].clientX - cropCanvas.getBoundingClientRect().left - cropImagePosX;
                startDragY = e.touches[0].clientY - cropCanvas.getBoundingClientRect().top - cropImagePosY;
            } else if (e.touches.length === 2) {
                initialPinchDistance = getPinchDistance(e.touches);
                isDragging = false; // Disable dragging when pinching
            }
        });

        cropCanvas.addEventListener('touchmove', (e) => {
            e.preventDefault(); // Prevent default touch behavior
            if (isDragging && e.touches.length === 1) {
                cropImagePosX = e.touches[0].clientX - cropCanvas.getBoundingClientRect().left - startDragX;
                cropImagePosY = e.touches[0].clientY - cropCanvas.getBoundingClientRect().top - startDragY;
                drawCropper();
            } else if (e.touches.length === 2) {
                const currentPinchDistance = getPinchDistance(e.touches);
                if (initialPinchDistance === 0) { // Handle case where touchstart didn't capture initial distance
                    initialPinchDistance = currentPinchDistance;
                }
                const scaleFactor = currentPinchDistance / initialPinchDistance;

                // Zoom around the center of the two touches
                const touchCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - cropCanvas.getBoundingClientRect().left;
                const touchCenterY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - cropCanvas.getBoundingClientRect().top;

                const oldScale = cropImageScale;
                cropImageScale *= scaleFactor;

                // Apply zoom limits (same as wheel event)
                const minScaleX = cropOverlay.offsetWidth / uploadedImage.width;
                const minScaleY = cropOverlay.offsetHeight / uploadedImage.height;
                cropImageScale = Math.max(cropImageScale, Math.max(minScaleX, minScaleY));
                cropImageScale = Math.min(cropImageScale, 5);

                // Ajusta a posição para o zoom ser no centro do mouse
                cropImagePosX = touchCenterX - ((touchCenterX - cropImagePosX) * (cropImageScale / oldScale));
                cropImagePosY = touchCenterY - ((touchCenterY - cropImagePosY) * (cropImageScale / oldScale));

                initialPinchDistance = currentPinchDistance; // Update initial distance for next move
                drawCropper();
            }
        });

        cropCanvas.addEventListener('touchend', () => {
            isDragging = false;
            initialPinchDistance = 0; // Reset pinch distance
        });

        function getPinchDistance(touches) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        confirmCropBtn.addEventListener('click', () => {
            // Cria um canvas temporário para o recorte final com as dimensões exatas
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = PHOTO_WIDTH_PX;
            tempCanvas.height = PHOTO_HEIGHT_PX;
            const tempCtx = tempCanvas.getContext('2d');

            // Calcula a posição da sobreposição de recorte relativa ao cropCanvas
            const overlayRect = cropOverlay.getBoundingClientRect();
            const canvasRect = cropCanvas.getBoundingClientRect();
            const overlayX = overlayRect.left - canvasRect.left;
            const overlayY = overlayRect.top - canvasRect.top;

            // Calcula as coordenadas e dimensões da área a ser recortada na imagem original
            // levando em consideração a posição e escala da imagem no cropCanvas.
            const sX = (overlayX - cropImagePosX) / cropImageScale;
            const sY = (overlayY - cropImagePosY) / cropImageScale;
            const sWidth = cropOverlay.offsetWidth / cropImageScale;
            const sHeight = cropOverlay.offsetHeight / cropImageScale;

            // Desenha a parte recortada da imagem original no canvas temporário
            tempCtx.drawImage(
                uploadedImage,
                sX, sY, sWidth, sHeight, // Retângulo de origem na imagem original
                0, 0, PHOTO_WIDTH_PX, PHOTO_HEIGHT_PX // Retângulo de destino no canvas temporário
            );

            // Converte o canvas temporário para Blob (PNG)
            tempCanvas.toBlob((blob) => {
                croppedImageBlob = blob;
                showStep(3);
            }, 'image/png');
        });

        backToStep1Btn.addEventListener('click', () => {
            showStep(1);
        });

        // --- Passo 3: Escolha de Data ---
        eventDateInput.addEventListener('change', () => {
            confirmDateBtn.disabled = !eventDateInput.value;
        });

        confirmDateBtn.addEventListener('click', () => {
            const dateString = eventDateInput.value;
            if (!dateString) {
                showAlert("Por favor, selecione uma data.");
                return;
            }

            const date = new Date(dateString + 'T00:00:00'); // Adiciona T00:00:00 para evitar problemas de fuso horário
            const dayOfWeek = date.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado

            if (dayOfWeek === 1 || dayOfWeek === 2) { // Segunda ou Terça
                showAlert("A casa não funciona às segundas e terças-feiras. Escolha outro dia.");
                eventDateInput.value = ''; // Limpa a data selecionada
                confirmDateBtn.disabled = true;
                return;
            }

            const day = date.getDate().toString().padStart(2, '0');
            const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
            const month = monthNames[date.getMonth()];

            let dayOfWeekText;
            let timeSlot;

            switch (dayOfWeek) {
                case 0: // Domingo
                    dayOfWeekText = "domingo";
                    timeSlot = "12H-22H";
                    break;
                case 3: // Quarta-feira
                    dayOfWeekText = "quarta";
                    timeSlot = "18H-0H";
                    break;
                case 4: // Quinta-feira
                    dayOfWeekText = "quinta";
                    timeSlot = "18H-0H";
                    break;
                case 5: // Sexta-feira
                    dayOfWeekText = "sexta";
                    timeSlot = "18H-01H";
                    break;
                case 6: // Sábado
                    dayOfWeekText = "sábado";
                    timeSlot = "14H-0H";
                    break;
            }

            selectedDate = {
                dayOfWeek: dayOfWeekText,
                dayMonth: `${day}/${month}`,
                timeSlot: timeSlot
            };

            showStep(4);
        });

        backToStep2Btn.addEventListener('click', () => {
            showStep(2);
        });

        // --- Passo 4: Arte Final e Download ---
        downloadBtn.addEventListener('click', () => {
            if (isAndroid()) {
                // Para Android, tenta um download direto
                const link = document.createElement('a');
                link.download = 'convite-javaripark.png';
                link.href = finalInvitationCanvas.toDataURL('image/png');
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                downloadInstructions.classList.add('hidden'); // Oculta instruções para download direto
                showAlert("Download do convite iniciado!");
            } else if (isIOS()) {
                // Para iOS, exibe a imagem e as instruções para salvar manualmente
                // Certifica-se de que a imagem final está visível para o iOS
                finalInvitationImage.src = finalInvitationCanvas.toDataURL('image/png');
                finalInvitationImage.classList.remove('hidden');
                finalInvitationCanvas.classList.add('hidden'); // Esconde o canvas para iOS
                downloadInstructions.classList.remove('hidden');
                showAlert("Pressione e segure a imagem acima para salvar o convite na sua fototeca.");
            } else {
                // Para desktop, aciona o download direto
                const link = document.createElement('a');
                link.download = 'convite-javaripark.png';
                link.href = finalInvitationCanvas.toDataURL('image/png');
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                downloadInstructions.classList.add('hidden'); // Oculta instruções para desktop
            }
        });

        function generateFinalInvitation() {
            finalInvitationCanvas.width = TEMPLATE_WIDTH_PX;
            finalInvitationCanvas.height = TEMPLATE_HEIGHT_PX;

            const templateImage = new Image();
            templateImage.crossOrigin = "anonymous"; // Necessário para carregar imagens de outras origens no canvas
            templateImage.src = 'assets/images/convite-template.png';

            templateImage.onload = () => {
                finalCtx.clearRect(0, 0, finalInvitationCanvas.width, finalInvitationCanvas.height);
                finalCtx.drawImage(templateImage, 0, 0, TEMPLATE_WIDTH_PX, TEMPLATE_HEIGHT_PX);

                // Desenha a imagem recortada do usuário
                if (croppedImageBlob) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const img = new Image();
                        img.onload = () => {
                            finalCtx.drawImage(img, PHOTO_X_OFFSET_PX, PHOTO_Y_OFFSET_PX, PHOTO_WIDTH_PX, PHOTO_HEIGHT_PX);
                            drawDateText(); // Desenha o texto da data após a imagem

                            // Após desenhar tudo no canvas, ajusta a visibilidade
                            if (isIOS()) {
                                finalInvitationImage.src = finalInvitationCanvas.toDataURL('image/png');
                                finalInvitationImage.classList.remove('hidden');
                                finalInvitationCanvas.classList.add('hidden'); // Esconde o canvas para iOS
                            } else {
                                finalInvitationImage.classList.add('hidden'); // Esconde a imagem para desktop/Android
                                finalInvitationCanvas.classList.remove('hidden'); // Mostra o canvas para desktop/Android
                            }
                        };
                        img.src = e.target.result;
                    };
                    reader.readAsDataURL(croppedImageBlob);
                } else {
                    drawDateText(); // Desenha o texto da data mesmo sem a imagem
                    // Atualiza a visibilidade mesmo sem a imagem de usuário
                    if (isIOS()) {
                        finalInvitationImage.src = finalInvitationCanvas.toDataURL('image/png');
                        finalInvitationImage.classList.remove('hidden');
                        finalInvitationCanvas.classList.add('hidden'); // Esconde o canvas para iOS
                    } else {
                        finalInvitationImage.classList.add('hidden'); // Esconde a imagem para desktop/Android
                        finalInvitationCanvas.classList.remove('hidden'); // Mostra o canvas para desktop/Android
                    }
                }
                downloadBtn.disabled = false; // Re-enable download if template loaded
            };

            templateImage.onerror = (e) => {
                console.error("Erro ao carregar o template do convite (provavelmente CORS ou restrição do ambiente de pré-visualização):", e);
                showAlert("Erro ao carregar o template do convite. Na pré-visualização, isso geralmente ocorre devido a restrições de segurança. Para o seu site WordPress, verifique as configurações de CORS do servidor. Detalhes no console do navegador (pressione F12).");

                // Desenha um fallback no canvas para indicar o erro
                finalCtx.clearRect(0, 0, finalInvitationCanvas.width, finalInvitationCanvas.height);
                finalCtx.fillStyle = '#f8d7da'; // Fundo vermelho claro
                finalCtx.fillRect(0, 0, finalInvitationCanvas.width, finalInvitationCanvas.height);
                finalCtx.fillStyle = '#721c24'; // Texto vermelho escuro
                finalCtx.font = 'bold 80px Arial'; // Tamanho maior para visibilidade
                finalCtx.textAlign = 'center';
                finalCtx.fillText('ERRO:', finalInvitationCanvas.width / 2, finalInvitationCanvas.height / 2 - 100);
                finalCtx.fillText('Template não carregado.', finalInvitationCanvas.width / 2, finalInvitationCanvas.height / 2);
                finalCtx.font = '40px Arial';
                finalCtx.fillText('Verifique o console (F12)', finalInvitationCanvas.width / 2, finalInvitationCanvas.height / 2 + 80);

                downloadBtn.disabled = true; // Desativa o download se o template falhou
            };
        }

        function drawDateText() {
            if (!selectedDate) return;

            // Configurações para sombra
            finalCtx.shadowColor = 'rgba(0, 0, 0, 0.5)'; // Cor da sombra
            finalCtx.shadowBlur = 4; // Intensidade do desfoque da sombra
            finalCtx.shadowOffsetX = 2; // Deslocamento X da sombra
            finalCtx.shadowOffsetY = 2; // Deslocamento Y da sombra

            finalCtx.fillStyle = '#ffffff'; // Cor do texto (branco para contraste)

            // [dia da semana] - Codec Pro Extrabold tamanho 20
            finalCtx.font = `${DAY_OF_WEEK_FONT_SIZE_PX}px 'Arial Black', sans-serif`; // Usando Arial Black como alternativa para Extrabold
            finalCtx.textAlign = 'left';
            finalCtx.fillText(selectedDate.dayOfWeek.toUpperCase(), DATE_X_OFFSET_PX, DATE_Y_OFFSET_PX);

            // [dia/mês] - Codec Pro Bold tamanho 11
            finalCtx.font = `${DAY_MONTH_TIME_FONT_SIZE_PX}px 'Arial', sans-serif`; // Usando Arial como alternativa para Bold
            finalCtx.fillText(selectedDate.dayMonth.toUpperCase(), DATE_X_OFFSET_PX, DATE_Y_OFFSET_PX + DAY_OF_WEEK_FONT_SIZE_PX * 0.8); // Ajusta a posição Y

            // [horário em formato período] - Codec Pro Bold tamanho 11
            finalCtx.font = `${DAY_MONTH_TIME_FONT_SIZE_PX}px 'Arial', sans-serif`; // Usando Arial como alternativa para Bold
            finalCtx.fillText(selectedDate.timeSlot.toUpperCase(), DATE_X_OFFSET_PX, DATE_Y_OFFSET_PX + DAY_OF_WEEK_FONT_SIZE_PX * 0.8 + DAY_MONTH_TIME_FONT_SIZE_PX * 1.2); // Ajusta a posição Y

            // Limpa as configurações de sombra para futuros desenhos
            finalCtx.shadowColor = 'transparent';
            finalCtx.shadowBlur = 0;
            finalCtx.shadowOffsetX = 0;
            finalCtx.shadowOffsetY = 0;
        }


        if (backToStep3Btn) {
            backToStep3Btn.addEventListener('click', () => {
                showStep(3);
            });
        }

        // Inicializa o primeiro passo ao carregar a página
        document.addEventListener('DOMContentLoaded', () => {
            showStep(1);
        });

        // Ajusta o tamanho do canvas de crop e overlay quando a janela é redimensionada
        window.addEventListener('resize', () => {
            if (currentStep === 2 && uploadedImage) {
                initCropper();
            }
        });
